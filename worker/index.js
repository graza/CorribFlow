const UPSTREAM = 'https://waterlevel.ie';
const ALLOWED_ORIGIN = 'https://graza.github.io';
const SITE_URL = `${ALLOWED_ORIGIN}/CorribFlow/`;
const CACHE_TTL = 900; // 15 minutes, matching OPW's update interval

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// Only proxy valid OPW station CSV paths
const VALID_PATH = /^\/data\/(day|week|month)\/\d+_OD\.csv$/;

// Flow thresholds in cumec at which to alert, starting at 100 in steps of 50
const THRESHOLDS = [100, 150, 200, 250, 300, 350, 400, 450, 500];

// Readings per moving-average window (15-min interval, so 75 minutes)
const SMOOTH_WINDOW = 5;

// Twice-daily summary hours, Dublin time
const REPORT_HOURS = [5, 15];

// Rolling chart periods for /day, /week and /month, bucketed like the website
const PERIODS = {
  day: { label: 'Last 24 hours', hours: 24 },
  week: { label: 'Last 7 days', hours: 7 * 24, bucketMinutes: 60, tickFormat: 'ddd D' },
  month: { label: 'Last 30 days', hours: 30 * 24, bucketMinutes: 360, tickFormat: 'D MMM' },
};

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

// Fetch the month CSVs and return all matched readings with smoothed values
async function fetchMatched() {
  console.log('fetchLatestFlow: fetching CSVs');
  const [r1, r2] = await Promise.all([
    fetch(`${UPSTREAM}/data/month/30089_OD.csv`, { headers: { Referer: UPSTREAM }, cache: 'no-store' }),
    fetch(`${UPSTREAM}/data/month/30099_OD.csv`, { headers: { Referer: UPSTREAM }, cache: 'no-store' }),
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

  // Smooth over the full month so every charted point has a complete window
  const smoothed = movingAverage(matched.map(p => p.flow), SMOOTH_WINDOW);
  return matched.map((p, i) => ({ ...p, smooth: smoothed[i] }));
}

function summariseFlow(matched) {
  const latest = matched[matched.length - 1];
  const pastIdx = Math.max(0, matched.length - 41); // ~10 hours ago
  return {
    datetime: latest.datetime,
    flowRate: latest.flow,
    smoothedFlow: latest.smooth,
    pastFlow: matched[pastIdx].smooth,
    series: matched.slice(-96), // last 24 hours; charts trim further
  };
}

async function fetchLatestFlow() {
  return summariseFlow(await fetchMatched());
}

// Inline keyboard button linking to the website view matching the message
function websiteButton(view) {
  return { inline_keyboard: [[{ text: '🌐 Open website', url: `${SITE_URL}?view=${view}` }]] };
}

// Pass `view` (day/week/month) to add a website button to the message
async function sendTelegramTo(env, chatId, message, view) {
  const body = { chat_id: chatId, text: message };
  if (view) body.reply_markup = websiteButton(view);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendPhotoTo(env, chatId, imageData, caption, view) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([imageData], { type: 'image/png' }), 'flow.png');
  form.append('caption', caption);
  form.append('reply_markup', JSON.stringify(websiteButton(view)));
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, { method: 'POST', body: form });
}

// Render a chart image via QuickChart; returns null (after logging) on failure
async function renderChart(env, context, chartConfig) {
  try {
    const qcRes = await fetch('https://quickchart.io/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: chartConfig, width: 500, height: 280, format: 'png', backgroundColor: 'white' }),
    });
    if (qcRes.ok) return await qcRes.arrayBuffer();
    await logError(env, context, new Error(`QuickChart ${qcRes.status}`));
  } catch (err) {
    await logError(env, context, err);
  }
  return null;
}

// Send a chart with caption, falling back to text if the chart can't be rendered
async function sendChartTo(env, chatId, context, caption, chartConfig, view) {
  const imageData = await renderChart(env, context, chartConfig);
  if (imageData) await sendPhotoTo(env, chatId, imageData, caption, view);
  else await sendTelegramTo(env, chatId, caption, view);
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
  // Discard cache entries with invalid values or from before smoothing was added
  return (flow?.flowRate != null && isFinite(flow.flowRate) && flow.smoothedFlow != null) ? flow : null;
}

async function logError(env, context, err) {
  const raw = await env.FLOW_KV.get('errors');
  const errors = raw ? JSON.parse(raw) : [];
  errors.unshift({ context, error: err?.message ?? String(err), timestamp: new Date().toISOString() });
  await env.FLOW_KV.put('errors', JSON.stringify(errors.slice(0, 10)));
}

async function broadcast(env, message, view) {
  const subscribers = await getSubscribers(env);
  await Promise.all(subscribers.map(chatId => sendTelegramTo(env, chatId, message, view)));
}

async function broadcastPhoto(env, caption, chartConfig, view) {
  const subscribers = await getSubscribers(env);
  if (subscribers.length === 0) return;

  // Fetch chart image once; fall back to text broadcast if QuickChart fails
  const imageData = await renderChart(env, 'broadcastPhoto', chartConfig);
  if (!imageData) {
    await broadcast(env, caption, view);
    return;
  }

  await Promise.all(subscribers.map(chatId => sendPhotoTo(env, chatId, imageData, caption, view)));
}

function parseUTC(datetime) {
  return Date.parse(datetime.replace(' ', 'T') + 'Z');
}

function timeAgo(datetime) {
  const diffMin = Math.round((Date.now() - parseUTC(datetime)) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ${diffMin % 60}m ago`;
}

// `extraLine` (optional) is inserted after the latest reading
function flowSummary({ flowRate, smoothedFlow, pastFlow, datetime }, extraLine) {
  const change = Math.round(smoothedFlow - pastFlow);
  const trend = change > 3 ? '📈' : change < -3 ? '📉' : '➡️';
  const changeStr = change >= 0 ? `+${change}` : `−${Math.abs(change)}`;
  // Thresholds use the raw reading, matching the alert logic
  const nextThreshold = THRESHOLDS.find(t => t > flowRate);
  const thresholdLine = nextThreshold ? `Next threshold: ${nextThreshold} cumec` : `Above all thresholds`;
  return `🌊 Corrib flow\n${smoothedFlow.toFixed(0)} cumec ${trend} (${changeStr} over 10h)\nLatest reading: ${flowRate.toFixed(0)} cumec\n${extraLine ? `${extraLine}\n` : ''}${thresholdLine}\n${datetime} UTC (${timeAgo(datetime)})`;
}

function dublinHour(date) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Dublin', hour: 'numeric', hour12: false }).format(date)
  );
}

// Most recent scheduled report time at or before `before`
function lastReportTime(before) {
  const t = new Date(before);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48 && !REPORT_HOURS.includes(dublinHour(t)); i++) {
    t.setTime(t.getTime() - 3600000);
  }
  return t.getTime();
}

// Chart from an hour before the given report time, but never less than 12 hours
function chartStart(reportTime) {
  return Math.min(reportTime - 3600000, Date.now() - 12 * 3600000);
}

function movingAverage(data, windowSize) {
  return data.map((_, i) => {
    const subset = data.slice(Math.max(0, i - windowSize + 1), i + 1);
    return subset.reduce((s, v) => s + v, 0) / subset.length;
  });
}

function buildChartConfig(fullSeries, startTime) {
  const series = fullSeries.filter(p => parseUTC(p.datetime) >= startTime);
  return {
    type: 'line',
    data: {
      labels: series.map(p => p.datetime.slice(11, 16)),
      datasets: [{
        label: 'Reading',
        data: series.map(p => p.flow),
        borderColor: 'rgba(54, 162, 235, 0.35)',
        fill: false,
        pointRadius: 0,
        borderWidth: 1,
        lineTension: 0,
      }, {
        label: `${SMOOTH_WINDOW * 15}-min average`,
        data: series.map(p => p.smooth),
        borderColor: 'rgb(54, 162, 235)',
        backgroundColor: 'rgba(54, 162, 235, 0.1)',
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        lineTension: 0.3,
      }],
    },
    options: {
      legend: { labels: { boxWidth: 12, fontSize: 11 } },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 7, fontSize: 11 } }],
        yAxes: [{ ticks: { beginAtZero: false }, scaleLabel: { display: true, labelString: 'cumec' } }],
      },
    },
  };
}

// Smoothed min–max over the charted points, e.g. "Last 7 days: 60–95 cumec"
function rangeLine(label, points) {
  const values = points.map(p => p.smooth);
  return `${label}: ${Math.min(...values).toFixed(0)}–${Math.max(...values).toFixed(0)} cumec`;
}

// Average readings into fixed-size UTC buckets, keyed by bucket start time
function bucketAverage(points, bucketMs) {
  const buckets = new Map();
  for (const p of points) {
    const key = Math.floor(parseUTC(p.datetime) / bucketMs) * bucketMs;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p.flow);
  }
  return [...buckets].map(([t, flows]) => ({ t, flow: flows.reduce((s, v) => s + v, 0) / flows.length }));
}

function buildPeriodChartConfig(points, { bucketMinutes, tickFormat }) {
  const buckets = bucketAverage(points, bucketMinutes * 60000);
  return {
    type: 'line',
    data: {
      datasets: [{
        data: buckets.map(b => ({ x: new Date(b.t).toISOString(), y: b.flow })),
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
        xAxes: [{
          type: 'time',
          time: { unit: 'day', displayFormats: { day: tickFormat } },
          ticks: { maxTicksLimit: 7, maxRotation: 0, fontSize: 11 },
        }],
        yAxes: [{ ticks: { beginAtZero: false }, scaleLabel: { display: true, labelString: 'cumec' } }],
      },
    },
  };
}

// Reply to /day, /week or /month with a rolling chart ending now
async function sendPeriodChart(env, chatId, view) {
  const period = PERIODS[view];
  const startTime = Date.now() - period.hours * 3600000;
  let flow, points, chartConfig;
  if (view === 'day') {
    // 24 hours fits in the cached series
    flow = await getCachedFlow(env) || await fetchLatestFlow();
    points = flow.series.filter(p => parseUTC(p.datetime) >= startTime);
    chartConfig = buildChartConfig(points, startTime);
  } else {
    const matched = await fetchMatched();
    flow = summariseFlow(matched);
    points = matched.filter(p => parseUTC(p.datetime) >= startTime);
    chartConfig = buildPeriodChartConfig(points, period);
  }
  await sendChartTo(env, chatId, `/${view}`, flowSummary(flow, rangeLine(period.label, points)), chartConfig, view);
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
        await sendTelegramTo(env, chatId, flowSummary(flow), 'day');
      } else if (text.startsWith('/chart')) {
        const cached = await getCachedFlow(env);
        const hasSeriesCache = cached?.series?.length > 0;
        console.log(hasSeriesCache ? `chart: using KV cache datetime=${cached.datetime}` : 'chart: KV cache miss or no series, fetching fresh');
        const flow = hasSeriesCache ? cached : await fetchLatestFlow();
        const chartConfig = buildChartConfig(flow.series, chartStart(lastReportTime(Date.now())));
        await sendChartTo(env, chatId, '/chart', flowSummary(flow), chartConfig, 'day');
      } else if (text.startsWith('/day')) {
        await sendPeriodChart(env, chatId, 'day');
      } else if (text.startsWith('/week')) {
        await sendPeriodChart(env, chatId, 'week');
      } else if (text.startsWith('/month')) {
        await sendPeriodChart(env, chatId, 'month');
      } else if (text.startsWith('/web')) {
        await sendTelegramTo(env, chatId, '🌐 Corrib flow website: charts, history and previous periods.', 'day');
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
    const { datetime, flowRate } = flow;
    console.log(`scheduled: flowRate=${flowRate.toFixed(1)} smoothed=${flow.smoothedFlow.toFixed(1)} datetime=${datetime}`);
    await env.FLOW_KV.put('latestFlow', JSON.stringify(flow), { expirationTtl: 900 });
    // Contract for Slipside: no TTL, so the last reading survives an outage.
    // Lives in SHARED_KV so Slipside can't reach FLOW_KV's subscribers or alert state.
    await env.SHARED_KV.put('latest', JSON.stringify({
      flow_m3s: Math.round(flow.smoothedFlow * 10) / 10,
      observed_at: new Date(parseUTC(datetime)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }));

    // Twice-daily summary at 5am and 3pm Dublin time (DST-aware)
    if (event.cron === '0 4,5,14,15 * * *') {
      if (REPORT_HOURS.includes(dublinHour(new Date()))) {
        // Previous report, looking back from before this one
        const since = lastReportTime(Date.now() - 3600000);
        await broadcastPhoto(env, flowSummary(flow), buildChartConfig(flow.series, chartStart(since)), 'day');
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
      await broadcast(env, alert, 'day');
    }
  },
};
