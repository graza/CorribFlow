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
        <button id="prev-period" onclick="shiftPeriod(1)">&#8592;</button>
        <span id="period-label"></span>
        <button id="next-period" onclick="shiftPeriod(-1)" disabled>&#8594;</button>
    </div>
    <h2 id="latestFlowRate">Latest Flow Rate: Loading...</h2>
    <canvas id="chart"></canvas>
    <table id="results">
        <tr><th>Datetime</th><th>Difference</th><th>Flow Rate (cumec)</th></tr>
    </table>
    <p><small>Contains Irish Public Sector Information licensed under a <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 International (CC BY 4.0)</a> licence. Source: <a href="https://waterlevel.ie">waterlevel.ie</a>, provided by the Office of Public Works.</small></p>

    <script>
        let timeRange = "day";
        let offset = 0; // 0 = current period, 1 = one period back, etc.
        let chartInstance = null;

        const WORKER_URL = 'https://corrib-flow.graza.workers.dev';
        const RANGE_INTERVAL_MS = { day: 0, week: 3600e3, month: 6 * 3600e3 };

        function parseUTC(datetime) {
            return new Date(datetime.replace(' ', 'T') + 'Z');
        }

        function getPeriodBounds() {
            const now = new Date();
            const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

            if (timeRange === 'day') {
                const start = todayUTC - offset * 86400000;
                const end = offset === 0 ? now.getTime() : start + 86400000;
                return { start, end };
            } else if (timeRange === 'week') {
                const dow = now.getUTCDay();
                const monday = todayUTC - (dow === 0 ? 6 : dow - 1) * 86400000;
                const start = monday - offset * 7 * 86400000;
                const end = offset === 0 ? now.getTime() : start + 7 * 86400000;
                return { start, end };
            } else {
                const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1);
                const end = offset === 0 ? now.getTime() : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 1);
                return { start, end };
            }
        }

        function getPeriodLabel() {
            const { start } = getPeriodBounds();
            const d = new Date(start);
            if (timeRange === 'day') {
                if (offset === 0) return 'Today';
                return d.toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
            } else if (timeRange === 'week') {
                if (offset === 0) return 'This week';
                return 'w/c ' + d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
            } else {
                if (offset === 0) return 'This month';
                return d.toLocaleDateString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
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
                let start = Math.max(0, i - windowSize + 1);
                let subset = data.slice(start, i + 1);
                let average = subset.reduce((sum, value) => sum + value, 0) / subset.length;
                result.push(average);
            }
            return result;
        }

        function formatTime(datetime) {
            return parseUTC(datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }

        function timeAgo(datetime) {
            const diffMinutes = Math.floor((Date.now() - parseUTC(datetime)) / 60000);
            if (diffMinutes < 1) return "just now";
            if (diffMinutes < 60) return `${diffMinutes} minutes ago (${formatTime(datetime)})`;
            const diffHours = Math.floor(diffMinutes / 60);
            if (diffHours < 24) return `${diffHours} hours ago (${formatTime(datetime)})`;
            const diffDays = Math.floor(diffHours / 24);
            return `${diffDays} days ago`;
        }

        function updateLatestFlowRate(differences) {
            const el = document.getElementById("latestFlowRate");
            if (differences.length === 0) {
                el.textContent = 'No data available for this period';
                return;
            }
            const latest = differences[differences.length - 1];
            if (offset === 0) {
                el.textContent = `Latest Flow Rate: ${latest.flowRate.toFixed(0)} cumec ${timeAgo(latest.datetime)}`;
            } else {
                const formattedDate = parseUTC(latest.datetime).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
                el.textContent = `Last reading: ${latest.flowRate.toFixed(0)} cumec at ${formattedDate}`;
            }
        }

        function displayResults(differences) {
            const table = document.getElementById("results");
            table.innerHTML = "<tr><th>Datetime</th><th>Difference (m)</th><th>Flow Rate (cumec)</th></tr>";
            for (let i = differences.length - 1; i >= 0; i--) {
                const row = differences[i];
                const formattedDate = parseUTC(row.datetime).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
                table.innerHTML += `<tr><td>${formattedDate}</td><td>${row.difference.toFixed(3)}m</td><td>${row.flowRate.toFixed(0)}cumec</td></tr>`;
            }
        }

        function plotChart(differences) {
            const ctx = document.getElementById("chart").getContext("2d");
            if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
            if (differences.length === 0) return;

            const labels = differences.map(d => parseUTC(d.datetime).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }));
            const smoothedData = movingAverage(differences.map(d => d.flowRate), 5);

            chartInstance = new Chart(ctx, {
                type: "line",
                data: {
                    labels,
                    datasets: [{
                        label: "Flow Rate (cumec)",
                        data: smoothedData,
                        borderColor: "blue",
                        fill: false,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { title: { display: true, text: "Datetime" } },
                        y: { title: { display: true, text: "Flow Rate (cumec)" } }
                    }
                }
            });
        }

        function updateNav() {
            document.getElementById('period-label').textContent = getPeriodLabel();
            document.getElementById('next-period').disabled = offset === 0;
        }

        function shiftPeriod(dir) {
            offset = Math.max(0, offset + dir);
            updateNav();
            loadAndCompare();
        }

        async function fetchCSV(url) {
            const response = await fetch(url);
            return parseCSV(await response.text());
        }

        async function loadAndCompare() {
            const url = `${WORKER_URL}/data/month/30089_OD.csv`;
            const url2 = `${WORKER_URL}/data/month/30099_OD.csv`;
            const [data1, data2] = await Promise.all([fetchCSV(url), fetchCSV(url2)]);
            const differences = computeDifferences(data1, data2);
            updateLatestFlowRate(differences);
            plotChart(differences);
            displayResults(differences);
        }

        function changeTimeRange(range) {
            timeRange = range;
            offset = 0;
            updateNav();
            loadAndCompare();
        }

        updateNav();
        window.onload = loadAndCompare;
    </script>
</body>
</html>
