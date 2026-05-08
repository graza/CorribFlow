---
layout: default
---

<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Corrib Flow Estimate</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
    <h1>Corrib Flow Estimate</h1>
    <nav>
        <a href="#" onclick="changeTimeRange('day')">Day</a> |
        <a href="#" onclick="changeTimeRange('week')">Week</a> |
        <a href="#" onclick="changeTimeRange('month')">Month</a>
    </nav>    <h2 id="latestFlowRate">Latest Flow Rate: Loading...</h2>
    <canvas id="chart"></canvas>
    <table id="results">
        <tr><th>Datetime</th><th>Difference</th><th>Flow Rate (cumec)</th></tr>
    </table>
    <p><small>Contains Irish Public Sector Information licensed under a <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 International (CC BY 4.0)</a> licence. Source: <a href="https://waterlevel.ie">waterlevel.ie</a>, provided by the Office of Public Works.</small></p>

    <script>
        let timeRange = "day";
        let chartInstance = null;
        
        const WORKER_URL = 'https://corrib-flow.graza.workers.dev';

        function getUrls(range) {
            return [
                `${WORKER_URL}/data/month/30089_OD.csv`,
                `${WORKER_URL}/data/month/30099_OD.csv`
            ];
        }

        async function fetchCSV(url) {
            const response = await fetch(url);
            return parseCSV(await response.text());
        }

        const RANGE_CUTOFF_MS = { day: 24 * 3600e3, week: 7 * 24 * 3600e3, month: 35 * 24 * 3600e3 };

        function parseUTC(datetime) {
            return new Date(datetime.replace(' ', 'T') + 'Z');
        }

        function parseCSV(text) {
            const rows = text.trim().split("\n").slice(1);
            const data = {};
            const cutoff = Date.now() - RANGE_CUTOFF_MS[timeRange];
            for (let row of rows) {
                const [datetime, level] = row.split(",");
                const dateObj = parseUTC(datetime);
                if (dateObj < cutoff) continue;
                const hours = dateObj.getUTCHours();
                const minutes = dateObj.getUTCMinutes();
                if (timeRange === "week" && minutes !== 0) continue;
                if (timeRange === "month" && (minutes !== 0 || ![0, 6, 12, 18].includes(hours))) continue;
                data[datetime] = parseFloat(level);
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
            if (chartInstance) {
                chartInstance.destroy();
            }
            const labels = differences.map(d => parseUTC(d.datetime).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }));
            const data = differences.map(d => d.flowRate);
            const smoothedData = movingAverage(data, 5);
        
            chartInstance = new Chart(ctx, {
                type: "line",
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: "Flow Rate (cumec)",
                            data: smoothedData,
                            borderColor: "blue",
                            fill: false,
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        x: { title: { display: true, text: "Datetime" } },
                        y: { title: { display: true, text: "Flow Rate (cumec)" } }
                    }
                }
            });
        }
        function updateLatestFlowRate(differences) {
            if (differences.length > 0) {
                const latest = differences[differences.length - 1];
                const relativeTime = timeAgo(latest.datetime);
                document.getElementById("latestFlowRate").textContent = `Latest Flow Rate: ${latest.flowRate.toFixed(0)} cumec ${relativeTime}`;
            }
        }
        async function loadAndCompare() {
            const [url1, url2] = getUrls(timeRange);
            const data1 = await fetchCSV(url1);
            const data2 = await fetchCSV(url2);
            
            const differences = computeDifferences(data1, data2);
            updateLatestFlowRate(differences);
            plotChart(differences);
            displayResults(differences);
        };
        function changeTimeRange(range) {
            timeRange = range;
            loadAndCompare();
        }
        window.onload = loadAndCompare;
    </script>
</body>
</html>
