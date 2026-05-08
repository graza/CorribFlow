const UPSTREAM = 'https://waterlevel.ie';
const ALLOWED_ORIGIN = 'https://graza.github.io';
const CACHE_TTL = 900; // 15 minutes, matching OPW's update interval

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Only proxy valid OPW station CSV paths
const VALID_PATH = /^\/data\/(day|week|month)\/\d+_OD\.csv$/;

// Flow thresholds in cumec at which to alert, starting at 100 in steps of 50
const THRESHOLDS = [100, 150, 200, 250, 300, 350, 400, 450, 500];

// Downward crossing fires this many cumec below the threshold to avoid
// repeated alerts when flow hovers near a boundary
const HYSTERESIS = 10;

async function fetchLatestFlow() {
  const [r1, r2] = await Promise.all([
    fetch(`${UPSTREAM}/data/day/30089_OD.csv`, { headers: { Referer: UPSTREAM } }),
    fetch(`${UPSTREAM}/data/day/30099_OD.csv`, { headers: { Referer: UPSTREAM } }),
  ]);
  const [t1, t2] = await Promise.all([r1.text(), r2.text()]);

  const lastRow1 = t1.trim().split('\n').pop().split(',');
  const lastRow2 = t2.trim().split('\n').pop().split(',');

  const datetime = lastRow1[0];
  const level1 = parseFloat(lastRow1[1]);
  const level2 = parseFloat(lastRow2[1]);
  const flowRate = 254.65 * (level1 - level2) + 28.883;

  return { datetime, flowRate };
}

async function sendTelegram(env, message) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { pathname } = new URL(request.url);

    if (!VALID_PATH.test(pathname)) {
      return new Response('Not found', { status: 404 });
    }

    const upstreamUrl = `${UPSTREAM}${pathname}`;
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl);

    let response = await cache.match(cacheKey);

    if (!response) {
      const upstream = await fetch(upstreamUrl, {
        headers: { Referer: UPSTREAM },
      });

      if (!upstream.ok) {
        return new Response('Upstream error', { status: upstream.status });
      }

      response = new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/csv',
        'Cache-Control': `public, max-age=${CACHE_TTL}`,
      },
    });
  },

  async scheduled(event, env, ctx) {
    const { datetime, flowRate } = await fetchLatestFlow();

    // crossedThresholds is the set of thresholds the flow is currently above
    const stateStr = await env.FLOW_KV.get('alertState');
    const crossed = new Set(stateStr ? JSON.parse(stateStr) : []);

    const alerts = [];

    for (const threshold of THRESHOLDS) {
      const alreadyCrossed = crossed.has(threshold);

      if (!alreadyCrossed && flowRate >= threshold) {
        alerts.push(
          `📈 Corrib flow rising\n` +
          `Crossed above ${threshold} cumec\n` +
          `Now: ${flowRate.toFixed(0)} cumec (${datetime} UTC)`
        );
        crossed.add(threshold);
      } else if (alreadyCrossed && flowRate < threshold - HYSTERESIS) {
        alerts.push(
          `📉 Corrib flow falling\n` +
          `Dropped below ${threshold} cumec\n` +
          `Now: ${flowRate.toFixed(0)} cumec (${datetime} UTC)`
        );
        crossed.delete(threshold);
      }
    }

    await env.FLOW_KV.put('alertState', JSON.stringify([...crossed]));

    for (const alert of alerts) {
      await sendTelegram(env, alert);
    }
  },
};
