---
layout: default
title: Water Level Difference
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
    <h2 id="latestFlowRate">Latest Flow Rate: Loading...</h2>
    <canvas id="chart"></canvas>
    <table id="results">
        <tr><th>Datetime</th><th>Difference</th><th>Flow Rate (cumec)</th></tr>
    </table>

    <script>
        const url1 = "https://waterlevel.ie/data/day/30089_OD.csv";
        const url2 = "https://waterlevel.ie/data/day/30099_OD.csv";

        async function fetchCSV(url) {
            const proxy = "https://api.allorigins.win/raw?url=";
            const response = await fetch(proxy + encodeURIComponent(url));
            const text = await response.text();
            console.log(`fetched {url}`)
            return parseCSV(text);
        }

        function parseCSV(text) {
            const rows = text.trim().split("\n").slice(1);
            const data = {};
            for (let row of rows) {
                const [datetime, level] = row.split(",");
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
            // Sort by datetime
            differences.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
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
            const date = new Date(datetime);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        function timeAgo(datetime) {
            const now = new Date();
            const past = new Date(datetime);
            const diffMs = now - past;
            const diffMinutes = Math.floor(diffMs / 60000);
            if (diffMinutes < 1) return "just now";
            if (diffMinutes < 60) return `${diffMinutes} minutes ago (${formatTime(datetime)})`;
            const diffHours = Math.floor(diffMinutes / 60);
            return `${diffHours} hours ago (${formatTime(datetime)})`;
            if (diffHours < 24) return `${diffHours} hours ago (${formatTime(datetime)})`;
            const diffDays = Math.floor(diffHours / 24);
            return `${diffDays} days ago`;
        }

        async function loadAndCompare() {
            const data1 = await fetchCSV(url1);
            const data2 = await fetchCSV(url2);
            
            const differences = computeDifferences(data1, data2);
            displayResults(differences);
            plotChart(differences);
            updateLatestFlowRate(differences);
        };

        function displayResults(differences) {
            const table = document.getElementById("results");
            for (let row of differences) {
                table.innerHTML = `<tr><td>${row.datetime}</td><td>${row.difference.toFixed(2)}</td><td>${row.flowRate.toFixed(2)}</td></tr>` + table.innerHTML;
            }
            table.innerHTML = "<tr><th>Datetime</th><th>Difference</th><th>Flow Rate (cumec)</th></tr> + table.innerHTML";
        }
        function plotChart(differences) {
            const ctx = document.getElementById("chart").getContext("2d");
            const labels = differences.map(d => d.datetime);
            const data = differences.map(d => d.flowRate);
            const smoothedData = movingAverage(data, 5);
        
            new Chart(ctx, {
                type: "line",
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: "Flow Rate (cumec)",
                            data: smoothedData,
                            borderColor: "blue",
                            fill: false
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
        window.onload = loadAndCompare;
    </script>
</body>
</html>
