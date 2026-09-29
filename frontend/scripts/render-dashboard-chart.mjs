// Renders the OwnerDashboard trend chart to standalone SVGs you can open and
// eyeball — three shapes of month: healthy, mixed, and a losing run.
//   OUT=/tmp/charts npm run render:dashboard-chart    (from frontend/)
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import OwnerDashboard from '../src/components/OwnerDashboard.jsx';
import fs from 'node:fs';

// Three shapes of month worth looking at: healthy, mixed, and a losing run.
const mk = (days, fn) => {
  const orders = [], expenses = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i); d.setHours(13, 0, 0, 0);
    const { rev, exp } = fn(days - 1 - i);
    orders.push({ status: 'paid', paidAt: d.toISOString(), type: 'day', total: rev, items: [] });
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    expenses.push({ id: 'e'+i, date: key, shop: 'day', category: 'ค่าวัตถุดิบ', amount: exp });
  }
  return { orders, expenses };
};
const cases = {
  'month-mixed': mk(30, i => ({ rev: 3000 + Math.round(2200 * Math.sin(i / 3)), exp: i % 5 === 0 ? 5200 : 1800 })),
  'week-good':   mk(7,  i => ({ rev: 4000 + i * 300, exp: 1500 })),
  'month-loss':  mk(30, i => ({ rev: 1200 + (i % 4) * 200, exp: 2600 })),
};

for (const [name, { orders, expenses }] of Object.entries(cases)) {
  const html = renderToStaticMarkup(React.createElement(OwnerDashboard, {
    orders, expenses, menu: [], menuPresets: [], setMenuPresets() {}, showToast() {},
  }));
  // The chart is the one SVG on the page carrying a plotted series; icons are
  // small and have no chart-* class, so match on that rather than a fixed viewBox.
  const svg = (html.match(/<svg[\s\S]*?<\/svg>/g) || []).find(s => s.includes('chart-'));
  if (!svg) { console.log(name, 'NO SVG FOUND'); continue; }
  // Inline the theme tokens so the standalone file paints like the app does.
  const themed = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg" style="background:#fff"')
    .replace('>', `><style>
      .stroke-chart-grid{stroke:#eceae5}.fill-chart-axis{fill:#8a8880}.stroke-chart-zero{stroke:#b8b4ab}
      .stroke-chart-cross{stroke:#c9c5bd}.stroke-chart-revenue{stroke:#2a78d6}
      .fill-chart-profit{fill:#15803D}.stroke-chart-profit{stroke:#15803D}
      .fill-chart-loss{fill:#DC2626}.stroke-chart-loss{stroke:#DC2626}
      .fill-chart-revenue{fill:#2a78d6}.stroke-chart-surface{stroke:#fff}
    </style>`);
  fs.writeFileSync(`${process.env.OUT}/${name}.svg`, themed);
  // geometry sanity
  console.log(name.padEnd(12), 'bars:', (themed.match(/fill-chart-(profit|loss)/g) || []).length,
    '| NaN:', /NaN/.test(themed), '| paths:', (themed.match(/<path/g) || []).length);
}
