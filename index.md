---
layout: default
title: Water Level Difference
---

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Water Level Difference</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
    <h1>Water Level Difference Calculator</h1>
    <!-- label for="csvUrl1">CSV URL 1:</label>
    <input type="text" id="csvUrl1" placeholder="Enter first CSV URL"><br>
    <label for="csvUrl2">CSV URL 2:</label>
    <input type="text" id="csvUrl2" placeholder="Enter second CSV URL"><br -->
    <button id="compareButton">Compare</button>
    <canvas id="chart"></canvas>
    <table id="results">
        <tr><th>Datetime</th><th>Difference</th><th>Flow Rate</th></tr>
    </table>

    <script>
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
            return differences;
        }

        document.getElementById("compareButton").addEventListener("click", async () => {
            //const url1 = document.getElementById("csvUrl1").value;
            //const url2 = document.getElementById("csvUrl2").value;
            const url1 = "https://waterlevel.ie/data/day/30089_OD.csv";
            const url2 = "https://waterlevel.ie/data/day/30099_OD.csv";
            
            const data1 = await fetchCSV(url1);
            const data2 = await fetchCSV(url2);
            
            const differences = computeDifferences(data1, data2);
            displayResults(differences);
            plotChart(differences);
        });

        function displayResults(differences) {
            const table = document.getElementById("results");
            table.innerHTML = "<tr><th>Datetime</th><th>Difference</th><th>Flow Rate</th></tr>";
            for (let row of differences) {
                table.innerHTML += `<tr><td>${row.datetime}</td><td>${row.difference.toFixed(2)}</td><td>${row.flowRate.toFixed(2)}</td></tr>`;
            }
        }
        function plotChart(differences) {
            const ctx = document.getElementById("chart").getContext("2d");
            const labels = differences.map(d => d.datetime);
            const data = differences.map(d => d.flowRate);
            
            new Chart(ctx, {
                type: "line",
                data: {
                    labels: labels,
                    datasets: [{
                        label: "Flow Rate",
                        data: data,
                        borderColor: "blue",
                        fill: false
                    }]
                },
                options: {
                    responsive: true,
                    scales: {
                        x: { title: { display: true, text: "Datetime" } },
                        y: { title: { display: true, text: "Flow Rate" } }
                    }
                }
            });
        }
    </script>
</body>
</html>
