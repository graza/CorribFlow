---
layout: default
---

<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Corrib Flow Estimate</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        #period-nav { margin: 0.5em 0; }
        #period-nav button { font-size: 1em; padding: 0 0.4em; cursor: pointer; }
        #period-nav button:disabled { opacity: 0.3; cursor: default; }
        #period-label { display: inline-block; min-width: 14em; text-align: center; font-weight: bold; }
    </style>
</head>
<body>
    <h1>Corrib Flow Estimate</h1>
    <nav>
        <a href="#" onclick="changeTimeRange('day')">Day</a> |
        <a href="#" onclick="changeTimeRange('week')">Week</a> |
        <a href="#" onclick="changeTimeRange('month')">Month</a>
    </nav>
    <div id="period-nav">
        <button id="prev-period" onclick="shiftPeriod(-1)">&#8592;</button>
        <span id="period-label"></span>
        <button id="next-period" onclick="shiftPeriod(1)" disabled>&#8594;</button>
    </div>
    <h2 id="latestFlowRate">Latest Flow Rate: Loading...</h2>
    <canvas id="chart"></canvas>
    <table id="results">
        <tr><th>Datetime</th><th>Difference</th><th>Flow Rate (cumec)</th></tr>
    </table>
    <p><small>Contains Irish Public Sector Information licensed under a <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 International (CC BY 4.0)</a> licence. Source: <a href="https://waterlevel.ie">waterlevel.ie</a>, provided by the Office of Public Works.</small></p>

    <script>
        let timeRange = 'day';
        let periodStart = null; // null = current period; Date = specific past period start (UTC midnight)
        let chartInstance = null;

        const WORKER_URL = 'https://corrib-flow.graza.workers.dev';
        const RANGE_INTERVAL_MS = { day: 0, week: 3600e3, month: 6 * 3600e3 };

        function parseUTC(datetime) {
            return new Date(datetime.replace(' ', 'T') + 'Z');
        }

        // Returns the UTC midnight Date of the start of the current period
        function currentPeriodStart() {
            const now = new Date();
            const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
            if (timeRange === 'day') {
                return new Date(todayUTC);
            } else if (timeRange === 'week') {
                const dow = now.getUTCDay();
                return new Date(todayUTC - (dow === 0 ? 6 : dow - 1) * 86400000);
            } else {
                return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            }
        }

        function getPeriodBounds() {
            const ps = periodStart || currentPeriodStart();
            return {
                start: ps.getTime(),
                end: timeRange === 'day'  ? ps.getTime() + 86400000 :
                     timeRange === 'week' ? ps.getTime() + 7 * 86400000 :
                     Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth() + 1, 1),
            };
        }

        function getPeriodLabel() {
            const ps = periodStart || currentPeriodStart();
            const isCurrent = !periodStart;
            if (timeRange === 'day') {
                if (isCurrent) return 'Today';
                return ps.toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
            } else if (timeRange === 'week') {
                if (isCurrent) return 'This week';
                return 'w/c ' + ps.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
            } else {
                if (isCurrent) return 'This month';
                return ps.toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
            }
        }

        // Returns the URL date param string for the current periodStart, or null if current period
        function getDateParam() {
            if (!periodStart) return null;
            const y = periodStart.getUTCFullYear();
            const m = String(periodStart.getUTCMonth() + 1).padStart(2, '0');
            if (timeRange === 'month') return `${y}-${m}`;
            const d = String(periodStart.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        function updateURL() {
            const params = new URLSearchParams({ view: timeRange });
            const date = getDateParam();
            if (date) params.set('date', date);
            history.pushState({ timeRange, periodStartMs: periodStart?.getTime() ?? null }, '', `?${params}`);
        }

        function applyState(state) {
            timeRange = state.timeRange;
            periodStart = state.periodStartMs != null ? new Date(state.periodStartMs) : null;
        }

        function applyURLParams() {
            const params = new URLSearchParams(location.search);
            timeRange = params.get('view') || 'day';
            const date = params.get('date');
            if (date) {
                const parts = date.split('-').map(Number);
                periodStart = timeRange === 'month'
                    ? new Date(Date.UTC(parts[0], parts[1] - 1, 1))
                    : new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
                // Treat as current if it matches the actual current period start
                if (periodStart >= currentPeriodStart()) periodStart = null;
            } else {
                periodStart = null;
            }
        }

        function parseCSV(text) {
            const rows = text.trim().split("\n").slice(1);
            const { start, end } = getPeriodBounds();
            const intervalMs = RANGE_INTERVAL_MS[timeRange];
            const data = {};
            let lastKept = null;
            for (let i = rows.length - 1; i >= 0; i--) {
                const [datetime, level] = rows[i].split(",");
                const dateObj = parseUTC(datetime);
                if (dateObj > end) continue;
                if (dateObj < start) break;
                if (lastKept === null || (lastKept - dateObj) >= intervalMs) {
                    data[datetime] = parseFloat(level);
                    lastKept = dateObj;
                }
            }
            return data;
        }

        function computeDifferences(data1, data2) {
            const differences = [];
            for (let datetime in data1) {
                if (data2[datetime] !== undefined) {
                    const difference = data1[datetime] - data2[datetime];
                    const flowRate = 254.65 * difference + 28.883;
                    differences.push({ datetime, difference, flowRate });
                }
            }
            differences.sort((a, b) => parseUTC(a.datetime) - parseUTC(b.datetime));
            return differences;
        }

        function movingAverage(data, windowSize) {
            let result = [];
            for (let i = 0; i < data.length; i++) {
                const subset = data.slice(Math.max(0, i - windowSize + 1), i + 1);
                result.push(subset.reduce((s, v) => s + v, 0) / subset.length);
            }
            return result;
        }

        function formatTime(datetime) {
            return parseUTC(datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        function timeAgo(datetime) {
            const diffMinutes = Math.floor((Date.now() - parseUTC(datetime)) / 60000);
            if (diffMinutes < 1) return 'just now';
            if (diffMinutes < 60) return `${diffMinutes} minutes ago (${formatTime(datetime)})`;
            const diffHours = Math.floor(diffMinutes / 60);
            if (diffHours < 24) return `${diffHours} hours ago (${formatTime(datetime)})`;
            return `${Math.floor(diffHours / 24)} days ago`;
        }

        function updateLatestFlowRate(differences) {
            const el = document.getElementById('latestFlowRate');
            if (differences.length === 0) {
                el.textContent = 'No data available for this period';
                return;
            }
            const latest = differences[differences.length - 1];
            if (!periodStart) {
                el.textContent = `Latest Flow Rate: ${latest.flowRate.toFixed(0)} cumec ${timeAgo(latest.datetime)}`;
            } else {
                const formattedDate = parseUTC(latest.datetime).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                el.textContent = `Last reading: ${latest.flowRate.toFixed(0)} cumec at ${formattedDate}`;
            }
        }

        function displayResults(differences) {
            const table = document.getElementById('results');
            table.innerHTML = '<tr><th>Datetime</th><th>Difference (m)</th><th>Flow Rate (cumec)</th></tr>';
            for (let i = differences.length - 1; i >= 0; i--) {
                const row = differences[i];
                const formattedDate = parseUTC(row.datetime).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                table.innerHTML += `<tr><td>${formattedDate}</td><td>${row.difference.toFixed(3)}m</td><td>${row.flowRate.toFixed(0)}cumec</td></tr>`;
            }
        }

        function plotChart(differences) {
            const ctx = document.getElementById('chart').getContext('2d');
            if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
            if (differences.length === 0) return;

            const fmt = d => d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
            const labels = differences.map(d => fmt(parseUTC(d.datetime)));
            const smoothedData = movingAverage(differences.map(d => d.flowRate), 5);

            // Pad current period to period end with nulls so the x-axis always spans the full period
            if (!periodStart) {
                const { end } = getPeriodBounds();
                const intervalMs = RANGE_INTERVAL_MS[timeRange] || 15 * 60 * 1000;
                const lastTime = parseUTC(differences[differences.length - 1].datetime).getTime();
                for (let t = lastTime + intervalMs; t < end; t += intervalMs) {
                    labels.push(fmt(new Date(t)));
                    smoothedData.push(null);
                }
            }

            chartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{ label: 'Flow Rate (cumec)', data: smoothedData, borderColor: 'blue', fill: false, tension: 0.4, spanGaps: false }]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { title: { display: true, text: 'Datetime' }, ticks: { maxTicksLimit: 12 } },
                        y: { title: { display: true, text: 'Flow Rate (cumec)' } }
                    }
                }
            });
        }

        function updateNav() {
            document.getElementById('period-label').textContent = getPeriodLabel();
            document.getElementById('next-period').disabled = !periodStart;
        }

        function shiftPeriod(dir) {
            const ps = periodStart || currentPeriodStart();
            let newStart;
            if (timeRange === 'day') {
                newStart = new Date(ps.getTime() + dir * 86400000);
            } else if (timeRange === 'week') {
                newStart = new Date(ps.getTime() + dir * 7 * 86400000);
            } else {
                newStart = new Date(Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth() + dir, 1));
            }
            periodStart = newStart >= currentPeriodStart() ? null : newStart;
            updateURL();
            updateNav();
            loadAndCompare();
        }

        function changeTimeRange(range) {
            timeRange = range;
            periodStart = null;
            updateURL();
            updateNav();
            loadAndCompare();
        }

        async function fetchCSV(url) {
            return parseCSV(await (await fetch(url)).text());
        }

        async function loadAndCompare() {
            const [data1, data2] = await Promise.all([
                fetchCSV(`${WORKER_URL}/data/month/30089_OD.csv`),
                fetchCSV(`${WORKER_URL}/data/month/30099_OD.csv`),
            ]);
            const differences = computeDifferences(data1, data2);
            updateLatestFlowRate(differences);
            plotChart(differences);
            displayResults(differences);
        }

        window.addEventListener('popstate', e => {
            if (e.state) applyState(e.state);
            else applyURLParams();
            updateNav();
            loadAndCompare();
        });

        applyURLParams();
        updateNav();
        window.onload = () => {
            history.replaceState({ timeRange, periodStartMs: periodStart?.getTime() ?? null }, '', location.href);
            loadAndCompare();
        };
    </script>
</body>
</html>
