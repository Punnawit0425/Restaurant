// Smoke-checks the CustomerView layout by server-rendering it once and comparing
// where things land in the HTML: drinks after food, the history button under the
// 3-step guide and above the dishes, exactly one of it.
//   npm run check:customer-view      (from frontend/)
import React from 'react';
import { renderToString } from 'react-dom/server';
import CustomerView from '../src/components/CustomerView.jsx';

const menu = [
  { id: 'f1', name: 'ข้าวผัด', category: 'ตามสั่ง', theme: 'both', price: 60, available: true },
  { id: 'f2', name: 'ต้มยำ',  category: 'ต้ม',     theme: 'both', price: 90, available: true },
  { id: 'd1', name: 'ชาเย็น',  category: 'ชา',      theme: 'both', price: 35, available: true, group: 'drink' },
  { id: 'd2', name: 'กาแฟ',   category: 'กาแฟ',    theme: 'both', price: 45, available: true, group: 'drink' },
];
const html = renderToString(React.createElement(CustomerView, {
  theme: 'day', lang: 'th', tableNo: 5, menu, orders: [], setOrders() {},
  stock: {}, cart: [], setCart() {}, addons: {}, choices: {}, addonPresets: [], showToast() {},
}));

const at = (s) => html.indexOf(s);
const rows = [
  ['food anchor id',      at('id="menu-group-food"')],
  ['drink anchor id',     at('id="menu-group-drink"')],
  ['ข้าวผัด (food)',       at('ข้าวผัด')],
  ['ต้มยำ (food)',         at('ต้มยำ')],
  ['ชาเย็น (drink)',       at('ชาเย็น')],
  ['กาแฟ (drink)',         at('กาแฟ')],
  ['ประวัติการสั่ง button', at('ตรวจสอบประวัติการสั่งของโต๊ะนี้')],
  ['3-step guide',        at('สั่งอาหารง่ายๆ ใน 3 ขั้นตอน')],
  ['off-menu notice',     at('หากต้องการสั่งอะไรนอกเหนือจากเมนู')],
];
rows.forEach(([n, i]) => console.log((i >= 0 ? 'ok  ' : 'MISS') + ` ${String(i).padStart(6)}  ${n}`));
console.log('\nall four dishes on one page:', ['ข้าวผัด','ต้มยำ','ชาเย็น','กาแฟ'].every(n => html.includes(n)));
console.log('drinks come after food:', at('กาแฟ') > at('ต้มยำ') && at('ชาเย็น') > at('ข้าวผัด'));
console.log('history button is above the dishes:', at('ตรวจสอบประวัติการสั่งของโต๊ะนี้') < at('ข้าวผัด'));
console.log('history button sits under the 3-step guide:', at('สั่งอาหารง่ายๆ ใน 3 ขั้นตอน') < at('ตรวจสอบประวัติการสั่งของโต๊ะนี้') && at('ตรวจสอบประวัติการสั่งของโต๊ะนี้') < at('หากต้องการสั่งอะไรนอกเหนือจากเมนู'));
console.log('only ONE history button:', html.split('ตรวจสอบประวัติการสั่งของโต๊ะนี้').length - 1);
