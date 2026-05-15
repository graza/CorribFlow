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

function parseCSVToMap(text) {
  const map = {};
  for (const row of text.trim().split('\n').slice(1)) {
    const comma = row.indexOf(',');
    if (comma > 0) {
      const val = parseFloat(row.slice(comma + 1));
      if (!isNaN(val)) map[row.slice(0, comma)] = val;
    }
  }
  return map;
}

async function fetchLatestFlow() {
  console.log('fetchLatestFlow: fetching CSVs');
  const [r1, r2] = await Promise.all([
    fetch(`${UPSTREAM}/data/day/30089_OD.csv`, { headers: { Referer: UPSTREAM }, cf: { cacheEverything: false } }),
    fetch(`${UPSTREAM}/data/day/30099_OD.csv`, { headers: { Referer: UPSTREAM }, cf: { cacheEverything: false } }),
  ]);

  console.log(`fetchLatestFlow: r1=${r1.status} r2=${r2.status}`);
  if (!r1.ok || !r2.ok) throw new Error(`Upstream error: ${r1.status} / ${r2.status}`);

  const [t1, t2] = await Promise.all([r1.text(), r2.text()]);
  const lastLine1 = t1.trim().split('\n').pop();
  const lastLine2 = t2.trim().split('\n').pop();
  console.log(`fetchLatestFlow: last row1=${JSON.stringify(lastLine1)}`);
  console.log(`fetchLatestFlow: last row2=${JSON.stringify(lastLine2)}`);
  const [map1, map2] = [t1, t2].map(parseCSVToMap);
  console.log(`fetchLatestFlow: map1=${Object.keys(map1).length} rows, map2=${Object.keys(map2).length} rows`);

  // Only use timestamps present in both CSVs, sorted chronologically
  const matched = Object.keys(map1)
    .filter(dt => map2[dt] !== undefined)
    .sort()
    .map(dt => ({ datetime: dt, flow: 254.65 * (map1[dt] - map2[dt]) + 28.883 }));

  console.log(`fetchLatestFlow: ${matched.length} matched rows`);
  if (matched.length === 0) throw new Error('No matching timestamps in CSV data');

  const latest = matched[matched.length - 1];
  console.log(`fetchLatestFlow: latest=${latest.datetime} flow=${latest.flow.toFixed(1)}`);

  const pastIdx = Math.max(0, matched.length - 41); // ~10 hours ago
  const seriesStart = Math.max(0, matched.length - 48); // last 12 hours

  return {
    datetime: latest.datetime,
    flowRate: latest.flow,
    pastFlow: matched[pastIdx].flow,
    series: matched.slice(seriesStart).map(p => ({ label: p.datetime.slice(11, 16), flow: Math.round(p.flow) })),
  };
}

async function sendTelegramTo(env, chatId, message) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
}

const SUBSCRIBER_LIMIT = 100;

async function getSubscribers(env) {
  const raw = await env.FLOW_KV.get('subscribers');
  return raw ? JSON.parse(raw) : [];
}

async function getCachedFlow(env) {
  const raw = await env.FLOW_KV.get('latestFlow');
  if (!raw) return null;
  const flow = JSON.parse(raw);
  // Discard cache entries with invalid values from before the alignment fix
  return (flow?.flowRate != null && isFinite(flow.flowRate)) ? flow : null;
}

async function logError(env, context, err) {
  const raw = await env.FLOW_KV.get('errors');
  const errors = raw ? JSON.parse(raw) : [];
  errors.unshift({ context, error: err?.message ?? String(err), timestamp: new Date().toISOString() });
  await env.FLOW_KV.put('errors', JSON.stringify(errors.slice(0, 10)));
}

async function broadcast(env, message) {
  const subscribers = await getSubscribers(env);
  await Promise.all(subscribers.map(chatId => sendTelegramTo(env, chatId, message)));
}

async function broadcastPhoto(env, caption, chartConfig) {
  const subscribers = await getSubscribers(env);
  if (subscribers.length === 0) return;

  // Fetch chart image once; fall back to text broadcast if QuickChart fails
  let imageData = null;
  try {
    const qcRes = await fetch('https://quickchart.io/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: chartConfig, width: 500, height: 280, format: 'png', backgroundColor: 'white' }),
    });
    if (qcRes.ok) {
      imageData = await qcRes.arrayBuffer();
    } else {
      await logError(env, 'broadcastPhoto', new Error(`QuickChart ${qcRes.status}`));
    }
  } catch (err) {
    await logError(env, 'broadcastPhoto', err);
  }

  if (!imageData) {
    await broadcast(env, caption);
    return;
  }

  await Promise.all(subscribers.map(chatId => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('photo', new Blob([imageData], { type: 'image/png' }), 'flow.png');
    form.append('caption', caption);
    return fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
  }));
}

function timeAgo(datetime) {
  const diffMin = Math.round((Date.now() - new Date(datetime.replace(' ', 'T') + 'Z')) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ${diffMin % 60}m ago`;
}

function flowSummary(flowRate, pastFlow, datetime) {
  const change = Math.round(flowRate - pastFlow);
  const trend = change > 3 ? '📈' : change < -3 ? '📉' : '➡️';
  const changeStr = change >= 0 ? `+${change}` : `−${Math.abs(change)}`;
  const nextThreshold = THRESHOLDS.find(t => t > flowRate);
  const thresholdLine = nextThreshold ? `Next threshold: ${nextThreshold} cumec` : `Above all thresholds`;
  return `🌊 Corrib flow\n${flowRate.toFixed(0)} cumec ${trend} (${changeStr} over 10h)\n${thresholdLine}\n${datetime} UTC (${timeAgo(datetime)})`;
}

function buildChartConfig(series) {
  return {
    type: 'line',
    data: {
      labels: series.map(p => p.label),
      datasets: [{
        data: series.map(p => p.flow),
        borderColor: 'rgb(54, 162, 235)',
        backgroundColor: 'rgba(54, 162, 235, 0.1)',
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        lineTension: 0.3,
      }],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 7, fontSize: 11 } }],
        yAxes: [{ ticks: { beginAtZero: false }, scaleLabel: { display: true, labelString: 'cumec' } }],
      },
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/telegram' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
      const update = await request.json();
      const message = update.message;
      const chatId = message?.chat?.id;
      const text = message?.text ?? '';

      try {
      if (text.startsWith('/start')) {
        const subscribers = await getSubscribers(env);
        if (!subscribers.includes(chatId)) {
          if (subscribers.length >= SUBSCRIBER_LIMIT) {
            await sendTelegramTo(env, chatId, '🔒 Subscriber limit reached.');
          } else {
            subscribers.push(chatId);
            await env.FLOW_KV.put('subscribers', JSON.stringify(subscribers));
            await sendTelegramTo(env, chatId, '✅ Subscribed to Corrib flow alerts.\nSend /stop to unsubscribe.');
          }
        } else {
          await sendTelegramTo(env, chatId, '✅ Already subscribed.\nSend /stop to unsubscribe.');
        }
      } else if (text.startsWith('/stop')) {
        const subscribers = await getSubscribers(env);
        const updated = subscribers.filter(id => id !== chatId);
        await env.FLOW_KV.put('subscribers', JSON.stringify(updated));
        await sendTelegramTo(env, chatId, '🔕 Unsubscribed from Corrib flow alerts.');
      } else if (text.startsWith('/flow')) {
        const cached = await getCachedFlow(env);
        console.log(cached ? `flow: using KV cache datetime=${cached.datetime}` : 'flow: KV cache miss, fetching fresh');
        const flow = cached || await fetchLatestFlow();
        await sendTelegramTo(env, chatId, flowSummary(flow.flowRate, flow.pastFlow, flow.datetime));
      } else if (text.startsWith('/chart')) {
        const cached = await getCachedFlow(env);
        const hasSeriesCache = cached?.series?.length > 0;
        console.log(hasSeriesCache ? `chart: using KV cache datetime=${cached.datetime}` : 'chart: KV cache miss or no series, fetching fresh');
        const { datetime, flowRate, pastFlow, series } = hasSeriesCache ? cached : await fetchLatestFlow();
        const summary = flowSummary(flowRate, pastFlow, datetime);
        let imageData = null;
        try {
          const qcRes = await fetch('https://quickchart.io/chart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chart: buildChartConfig(series), width: 500, height: 280, format: 'png', backgroundColor: 'white' }),
          });
          if (qcRes.ok) imageData = await qcRes.arrayBuffer();
          else await logError(env, '/chart', new Error(`QuickChart ${qcRes.status}`));
        } catch (err) {
          await logError(env, '/chart', err);
        }
        if (imageData) {
          const form = new FormData();
          form.append('chat_id', String(chatId));
          form.append('photo', new Blob([imageData], { type: 'image/png' }), 'flow.png');
          form.append('caption', summary);
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, { method: 'POST', body: form });
        } else {
          await sendTelegramTo(env, chatId, summary);
        }
      }
      } catch (err) {
        console.error(`telegram webhook error: ${err.message}`);
        await logError(env, 'telegram:webhook', err);
      }

      return new Response('OK');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

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
    console.log(`scheduled: cron=${event.cron}`);
    let flow;
    try {
      flow = await fetchLatestFlow();
    } catch (err) {
      console.error(`scheduled: fetchLatestFlow failed: ${err.message}`);
      await logError(env, `scheduled:${event.cron}`, err);
      return;
    }
    const { datetime, flowRate, pastFlow, series } = flow;
    console.log(`scheduled: flowRate=${flowRate.toFixed(1)} datetime=${datetime}`);
    await env.FLOW_KV.put('latestFlow', JSON.stringify({ datetime, flowRate, pastFlow, series }), { expirationTtl: 900 });

    // Twice-daily summary at 5am and 3pm Dublin time (DST-aware)
    if (event.cron === '0 4,5,14,15 * * *') {
      const dublinHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Dublin', hour: 'numeric', hour12: false }).format(new Date())
      );
      if (dublinHour === 5 || dublinHour === 15) {
        await broadcastPhoto(env, flowSummary(flowRate, pastFlow, datetime), buildChartConfig(series));
      }
      return;
    }

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
      await broadcast(env, alert);
    }
  },
};
