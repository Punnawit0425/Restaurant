// Smoke-checks the OwnerDashboard menu table: 45 dishes must page at 20 rows,
// and a bill from last year must not leak into this year's stats.
//   npm run check:dashboard-paging   (from frontend/)
import React from 'react';
import { renderToString } from 'react-dom/server';
import OwnerDashboard from '../src/components/OwnerDashboard.jsx';
import { menuStats } from '../src/stats.js';

// 45 dishes so the table has to page (20 per page -> 3 pages)
const menu = Array.from({ length: 45 }, (_, i) => ({
  id: `d${i}`, name: `เมนู ${i + 1}`, price: 50 + i, category: 'ตามสั่ง', theme: 'day',
}));
const now = new Date();
const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const orders = [
  { status: 'paid', paidAt: `${iso}T13:00:00`, type: 'day', total: 5000,
    items: menu.map((m, i) => ({ name: m.name, qty: 45 - i, price: m.price })) },
  // a bill from LAST year, to prove the year filter separates them
  { status: 'paid', paidAt: `${now.getFullYear() - 1}-05-04T13:00:00`, type: 'day', total: 100,
    items: [{ name: 'เมนูปีก่อน', qty: 7, price: 100 }] },
];

const html = renderToString(React.createElement(OwnerDashboard, {
  orders, expenses: [], menu, menuPresets: [], setMenuPresets() {}, showToast() {},
}));
console.log('rendered', html.length, 'chars');
for (const n of ['รายวัน', 'รายเดือน', 'รายปี', 'ก่อนหน้า', 'ถัดไป', 'จาก 45']) {
  console.log((html.includes(n) ? '  ok      ' : '  MISSING ') + n);
}
// 20 rows on page 1: last visible should be "20." and "21." must not be there
console.log('  ' + (html.includes('20.') && !html.includes('21.') ? 'ok       exactly 20 rows on page 1' : 'BAD      page size'));

const y = String(now.getFullYear());
console.log('year', y, '->', menuStats(orders, menu, { periodKey: y }).length, 'dishes');
console.log('year', y - 1, '->', JSON.stringify(menuStats(orders, menu, { periodKey: String(now.getFullYear() - 1) })));
