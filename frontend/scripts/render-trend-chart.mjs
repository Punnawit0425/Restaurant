// Same idea as render-dashboard-chart.mjs but drives TrendChart directly, so the
// bar counts are exact: week (7), year (12, one loss month), month (30, dense).
//   OUT=/tmp/charts npm run render:trend-chart        (from frontend/)
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrendChart } from '../src/components/OwnerDashboard.jsx';
import fs from 'node:fs';

const day = (i) => { const d = new Date(); d.setDate(d.getDate() - i); d.setHours(12,0,0,0); return d; };
const mk = (n, fn) => Array.from({ length: n }, (_, k) => {
  const { revenue, expense } = fn(k);
  return { key: `k${k}`, date: day(n - 1 - k), revenue, expense, profit: revenue - expense };
});

const cases = {
  // 7 bars — the closest shape to the reference image
  'week':  ['week',  mk(7,  k => ({ revenue: [12000,20000,24000,9000,23000,30000,50000][k], expense: [7000,14000,16000,11000,15000,19000,30000][k] }))],
  // 12 bars, one loss month
  'year':  ['year',  mk(12, k => ({ revenue: 300000 + k * 18000, expense: k === 3 ? 420000 : 210000 + k * 9000 }))],
  // 30 bars, the dense case
  'month': ['month', mk(30, k => ({ revenue: 3000 + Math.round(2200 * Math.sin(k / 3)), expense: k % 5 === 0 ? 5200 : 1800 }))],
};

const CSS = `
 svg{--c-chart-revenue:#2a78d6;--c-chart-profit:#15803D;--c-chart-loss:#DC2626}
 .stroke-chart-grid{stroke:#eceae5}.fill-chart-axis{fill:#8a8880}.stroke-chart-zero{stroke:#b8b4ab}
 .stroke-chart-cross{stroke:#c9c5bd}.stroke-chart-revenue{stroke:#2a78d6}.fill-chart-revenue{fill:#2a78d6}
 .fill-chart-profit{fill:#15803D}.stroke-chart-profit{stroke:#15803D}
 .fill-chart-loss{fill:#DC2626}.stroke-chart-loss{stroke:#DC2626}.stroke-chart-surface{stroke:#fff}`;

for (const [name, [range, points]] of Object.entries(cases)) {
  const html = renderToStaticMarkup(React.createElement(TrendChart, { points, range }));
  const svg = /<svg[\s\S]*?<\/svg>/.exec(html)[0]
    .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg" style="background:#fff"')
    .replace('>', `><style>${CSS}</style>`);
  fs.writeFileSync(`${process.env.OUT}/look-${name}.svg`, svg);
  console.log(name.padEnd(6), 'bars:', (svg.match(/<path d="M[\d.]+,[\d.]+ L/g) || []).length, '| NaN:', /NaN/.test(svg));
}
