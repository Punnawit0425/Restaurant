// ---------------------------------------------------------------------------
// Owner dashboard aggregations
// ---------------------------------------------------------------------------
// Turns the raw `orders` + `expenses` lists into the daily series and per-dish
// rollups the dashboard draws. Everything here is pure so it can be memoised.
// ---------------------------------------------------------------------------

import { orderShift, workdayKey } from './shift';
import { isDrinkItem } from './menu-groups';
import { isDiscountItem } from './orders';
import { entryKind } from './expenses';

// Which day an order belongs to. Paid bills are counted on the day they were
// SETTLED (that is when the money arrived); anything else falls back to when it
// was created.
//
// The day is the WORKING day, not the calendar one: it runs 06:00 → 06:00, the
// same boundary the time clock uses, so the night side's last bills — settled at
// 00:30, at 02:00 — are counted on the evening that earned them instead of
// opening tomorrow's takings while the shop is still serving. Which means the
// dashboard's "วันนี้" resets at 06:00, not at midnight.
export function orderDateKey(order) {
  const ts = order?.paidAt || order?.createdAt;
  return ts ? workdayKey(new Date(ts)) : null;
}

// What one order line actually brought in: unit price plus its add-ons, times qty.
// (`addonCost` is per unit — the same way StaffView computes an order total.)
export function lineRevenue(item) {
  return ((Number(item?.price) || 0) + (Number(item?.addonCost) || 0)) * (Number(item?.qty) || 0);
}

// Sold lines record the dish name with its chosen variant appended, e.g.
// "ทอดน้ำปลาราดข้าว (หมู)", while the menu stores the base name only. Try an
// exact hit first, then again with a trailing "(...)" stripped.
export function resolveMenuItem(name, menu) {
  if (!name) return null;
  const exact = (menu || []).find((m) => m.name === name);
  if (exact) return exact;
  const base = name.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return (menu || []).find((m) => m.name === base) || null;
}

// 'food' | 'drink' for a sold line. Off-menu dishes (เมนูนอกเล่ม) resolve to
// nothing — they are counted as food, since that is what they always are here.
export function lineGroup(name, menu) {
  const item = resolveMenuItem(name, menu);
  if (!item) return 'food';
  return isDrinkItem(item) ? 'drink' : 'food';
}

// Orders that count as revenue: settled, and matching the chosen shift.
// `shift` is 'day' | 'night' | 'all'.
function revenueOrders(orders, shift) {
  return (orders || []).filter(
    (o) => o.status === 'paid' && (shift === 'all' || orderShift(o) === shift)
  );
}

// Hand-keyed ledger entries for one shift, one side of the book at a time.
// The `expenses` list holds both: outgoings, and income the owner typed in
// because it never passed through a bill. That income is real money in, so it
// has to join the billed takings: counted only against the outgoings it would
// under-report both revenue and profit, every day it was recorded on.
function shiftEntries(expenses, shift, kind) {
  return (expenses || []).filter(
    (e) => (shift === 'all' || e.shop === shift) && entryKind(e) === kind
  );
}

// Revenue / expense / profit for one calendar day.
export function dayTotals(orders, expenses, shift, dateKey) {
  const billed = revenueOrders(orders, shift)
    .filter((o) => orderDateKey(o) === dateKey)
    .reduce((n, o) => n + (Number(o.total) || 0), 0);
  const onDay = (kind) =>
    shiftEntries(expenses, shift, kind)
      .filter((e) => e.date === dateKey)
      .reduce((n, e) => n + (Number(e.amount) || 0), 0);
  const revenue = billed + onDay('income');
  const expense = onDay('expense');
  return { revenue, expense, profit: revenue - expense };
}

// How the day's takings split across the money types staff actually received:
//   cash  → เงินสด            (money in the till)
//   qr    → เงินในบัญชีร้าน    (PromptPay straight to the shop's bank account)
//   split → เงินในเป๋าตัง      (คนละครึ่ง — the government G-Wallet app)
// A settled bill with no `payMethod` (older records) is folded into cash, since
// that is what an un-tagged takings almost always was. Scoped to one day + shift.
//
// Bills only: hand-keyed รายรับ records no payment method, so it is deliberately
// left out. These three tiles answer "where did the money physically land?",
// not "what did the day bring in" — that is the ยอดขาย tile, which does include it.
export function dayTakingsByMethod(orders, shift, dateKey) {
  const takings = { cash: 0, qr: 0, split: 0 };
  revenueOrders(orders, shift)
    .filter((o) => orderDateKey(o) === dateKey)
    .forEach((o) => {
      const method = takings[o.payMethod] != null ? o.payMethod : 'cash';
      takings[method] += Number(o.total) || 0;
    });
  return takings;
}

// The same three money types as rows rather than tiles, in the order the owner
// reads them, plus one that is not a payment method at all: `other` is where
// hand-keyed รายรับ lands, since nothing recorded how that money arrived. It
// stays in the list so a breakdown always foots to the period's total income
// instead of quietly dropping money the ledger right below it is showing.
export const PAY_METHODS = [
  { id: 'cash', label: 'เงินสด' },
  { id: 'split', label: 'เป๋าตัง' },
  { id: 'qr', label: 'บัญชีธนาคาร' },
  { id: 'other', label: 'รายรับนอกบิล' },
];

const PAY_METHOD_IDS = PAY_METHODS.map((m) => m.id);

// One period's takings split by money type, per shop and combined. Unlike
// dayTakingsByMethod this is never scoped to a shift — the two shops ARE the
// columns — and it does include the hand-keyed รายรับ, under `other`.
//
// `periodKey` is matched as a PREFIX of the day key, so the same function serves
// both halves of the picker with no second code path: 'YYYY-MM' is a month,
// 'YYYY-MM-DD' is that one working day (06:00 → 06:00, the same day the takings
// are counted on everywhere else).
//
// Shape: { day: {...counts, total}, night: {...}, all: {...} }
export function takingsByMethod(orders, expenses, periodKey) {
  const zero = () => ({ cash: 0, split: 0, qr: 0, other: 0, total: 0 });
  const out = { day: zero(), night: zero(), all: zero() };

  // A row for a shop id that is neither 'day' nor 'night' cannot be shown in a
  // two-column table, but it still belongs in the combined column — dropping it
  // would make รวม disagree with the ledger's total.
  const add = (shop, method, amount) => {
    if (!amount) return;
    [out.all, out[shop]].forEach((col) => {
      if (!col) return;
      col[method] += amount;
      col.total += amount;
    });
  };

  (orders || [])
    .filter((o) => o.status === 'paid')
    .forEach((o) => {
      const date = orderDateKey(o);
      if (!date || !date.startsWith(periodKey)) return;
      // Bills from before payMethod was recorded fall into cash, the same
      // assumption the day tiles make.
      const method = PAY_METHOD_IDS.includes(o.payMethod) && o.payMethod !== 'other'
        ? o.payMethod
        : 'cash';
      add(orderShift(o), method, Number(o.total) || 0);
    });

  (expenses || []).forEach((e) => {
    if (entryKind(e) !== 'income') return;
    if (!e.date || !e.date.startsWith(periodKey)) return;
    add(e.shop, 'other', Number(e.amount) || 0);
  });

  return out;
}

// The last `days` working days ending with the one in progress, oldest first,
// each with its totals. Days with no trade are still present as zeroes so the
// line keeps a real time axis instead of silently compressing gaps.
export function dailySeries(orders, expenses, shift, days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    // workdayKey, not todayKey: these keys are compared against orderDateKey,
    // and between midnight and 06:00 the two disagree by a day — the column for
    // "today" would sit empty while the night's takings piled into a day that is
    // not on the chart yet.
    const key = workdayKey(d);
    // The axis label is read back OUT of the key (midday, so no timezone can
    // nudge it across a boundary), not from `d` — at 02:00 those are different
    // dates, and a column labelled with tomorrow's date over yesterday's takings
    // is worse than no label.
    out.push({ key, date: new Date(`${key}T12:00:00`), ...dayTotals(orders, expenses, shift, key) });
  }
  return out;
}

// Same shape as dailySeries but bucketed by calendar month, for the 'ปี' range.
export function monthlySeries(orders, expenses, shift, months = 12, now = new Date()) {
  const paid = revenueOrders(orders, shift);
  const extra = shiftEntries(expenses, shift, 'income');
  const exps = shiftEntries(expenses, shift, 'expense');
  const out = [];
  const inMonth = (list, prefix) =>
    list
      .filter((e) => (e.date || '').startsWith(prefix))
      .reduce((n, e) => n + (Number(e.amount) || 0), 0);
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const revenue =
      paid
        .filter((o) => orderDateKey(o)?.startsWith(prefix))
        .reduce((n, o) => n + (Number(o.total) || 0), 0) + inMonth(extra, prefix);
    const expense = inMonth(exps, prefix);
    out.push({ key: prefix, date: d, revenue, expense, profit: revenue - expense });
  }
  return out;
}

// A sold line records the dish name with its chosen variant appended —
// "ทอดน้ำปลาราดข้าว (หมู)" — while the menu stores the base name. This is the
// name to match a line against a list of dishes by.
function baseDishName(name) {
  return (name || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
}

// The dish NAMES a set of menu ids stands for. Presets are stored as ids (the
// menu's own identity, which survives a rename), but the stats table rolls sales
// up by name — and the same dish exists twice, once per shop, under two ids. So
// a preset is read back as names: ticking ผัดกะเพรา means ผัดกะเพรา, whichever
// kitchen cooked it, which is the only question this table can answer.
export function presetDishNames(menu, menuIds) {
  const wanted = new Set(menuIds || []);
  const names = new Set();
  (menu || []).forEach((m) => {
    if (wanted.has(m.id) && m.name) names.add(m.name);
  });
  return names;
}

// Per-dish totals across every non-cancelled order in the chosen shift.
// Options:
//   shift     — 'all' | 'day' | 'night'
//   group     — 'all' | 'food' | 'drink'
//   sortBy    — 'qty' | 'revenue'
//   periodKey — 'YYYY-MM-DD' (one working day) or 'YYYY-MM' (a month), matched
//               as a prefix of the order's day key. Omitted = all time.
//   names     — a Set of dish names to keep (เฉพาะเมนู, from a preset). Omitted
//               = every dish. An EMPTY set really does mean "nothing", which is
//               what a preset holding no dishes should show.
export function menuStats(orders, menu, { shift = 'all', group = 'all', sortBy = 'qty', periodKey, names } = {}) {
  const rows = new Map();

  (orders || [])
    .filter((o) => o.status !== 'cancelled' && (shift === 'all' || orderShift(o) === shift))
    .filter((o) => {
      if (!periodKey) return true;
      const key = orderDateKey(o);
      return !!key && key.startsWith(periodKey);
    })
    .forEach((o) => {
      (o.items || []).forEach((item) => {
        // A ส่วนลด is a line on the bill, not a dish sold: counting it here would
        // invent a menu item with negative revenue and put it at the top of the
        // "least sold" list.
        if (isDiscountItem(item)) return;
        if (names && !names.has(item.name) && !names.has(baseDishName(item.name))) return;
        const g = lineGroup(item.name, menu);
        if (group !== 'all' && g !== group) return;
        const row = rows.get(item.name) || { name: item.name, group: g, qty: 0, revenue: 0 };
        row.qty += Number(item.qty) || 0;
        row.revenue += lineRevenue(item);
        rows.set(item.name, row);
      });
    });

  // Ties break on the other measure, so the order stays stable and sensible.
  return [...rows.values()].sort((a, b) =>
    sortBy === 'revenue' ? b.revenue - a.revenue || b.qty - a.qty : b.qty - a.qty || b.revenue - a.revenue
  );
}

// Percent change from `prev` to `curr`. Returns null when there is no baseline
// to compare against — "+100%" against a zero yesterday would be a lie.
export function percentChange(curr, prev) {
  if (!prev) return null;
  return ((curr - prev) / prev) * 100;
}

// --- Monthly summary / export ----------------------------------------------
// The export deliberately does NOT list bills one by one: income is rolled up to
// a single line per day per shop ("รายรับรวมประจำวัน"), and outgoings to one line
// per day/shop/category. That is the shape the owner's book wants.

// Every 'YYYY-MM' that has any trade in it, newest first, plus the current month
// so a fresh month is always selectable.
export function availableMonths(orders, expenses, now = new Date()) {
  const months = new Set();
  (orders || []).forEach((o) => {
    const key = orderDateKey(o);
    if (key && o.status === 'paid') months.add(key.slice(0, 7));
  });
  (expenses || []).forEach((e) => {
    if (e.date) months.add(e.date.slice(0, 7));
  });
  months.add(workdayKey(now).slice(0, 7));
  return [...months].sort().reverse();
}

// Flat rows for one month, sorted newest day first. Shape:
//   { date, shop, kind: 'income'|'expense', label, amount }
export function summaryRows(orders, expenses, monthKey) {
  const buckets = new Map(); // `${date}|${shop}|${kind}|${label}` -> amount

  const add = (date, shop, kind, label, amount) => {
    const k = `${date}|${shop}|${kind}|${label}`;
    buckets.set(k, (buckets.get(k) || 0) + amount);
  };

  (orders || [])
    .filter((o) => o.status === 'paid')
    .forEach((o) => {
      const date = orderDateKey(o);
      if (!date || !date.startsWith(monthKey)) return;
      add(date, orderShift(o), 'income', 'รายรับรวมประจำวัน', Number(o.total) || 0);
    });

  // Both sides of the hand-keyed book roll up the same way — by day, shop and
  // category — so income typed in by the owner lands next to the day's bills.
  (expenses || []).forEach((e) => {
    if (!e.date || !e.date.startsWith(monthKey)) return;
    add(e.date, e.shop, entryKind(e), `${e.category}รวมประจำวัน`, Number(e.amount) || 0);
  });

  return [...buckets.entries()]
    .map(([k, amount]) => {
      const [date, shop, kind, label] = k.split('|');
      return { date, shop, kind, label, amount };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.shop.localeCompare(b.shop) || a.kind.localeCompare(b.kind));
}

// --- Ledger rows (หน้าการเงิน) ----------------------------------------------
// What the on-screen ประวัติรายรับ-รายจ่าย table lists. It differs from
// summaryRows in ONE way that matters: an expense stays its own row, keeping the
// note the owner typed and the id needed to delete it. Rolling outgoings up (as
// the export sheet does) would throw both away and leave a row nobody can act on.
// Billed income is still one line per day per shop — bills are never listed one
// by one. Income the owner keyed in by hand is not billed income: it is a ledger
// entry like any other, so it keeps its own row, its note and its delete.
//
// Shape: { key, date, shop, kind: 'income'|'expense', label, note, amount, id }
// `id` is null only on the rolled-up bill rows, which is what marks those (and
// only those) as undeletable — the bills are where that money is recorded.
export function ledgerRows(orders, expenses, monthKey) {
  const rows = [];

  const income = new Map(); // `${date}|${shop}` -> amount
  (orders || [])
    .filter((o) => o.status === 'paid')
    .forEach((o) => {
      const date = orderDateKey(o);
      if (!date || !date.startsWith(monthKey)) return;
      const k = `${date}|${orderShift(o)}`;
      income.set(k, (income.get(k) || 0) + (Number(o.total) || 0));
    });
  income.forEach((amount, k) => {
    const [date, shop] = k.split('|');
    rows.push({
      key: `income|${k}`,
      date, shop, kind: 'income',
      label: 'รายรับรวมประจำวัน', note: '', amount, id: null, createdAt: 0,
    });
  });

  (expenses || []).forEach((e) => {
    if (!e.date || !e.date.startsWith(monthKey)) return;
    rows.push({
      // Keyed on the id alone, not on the side of the book: an entry keeps its
      // id for life, and prefixing by kind would only be a second name for it.
      key: `entry|${e.id}`,
      date: e.date,
      shop: e.shop,
      kind: entryKind(e),
      label: e.category,
      note: e.note || '',
      amount: Number(e.amount) || 0,
      id: e.id,
      createdAt: e.createdAt || 0,
    });
  });

  // Newest day first; within a day the income side leads, then the latest entry.
  // (b.kind vs a.kind because 'expense' sorts before 'income' alphabetically.)
  // The rolled-up takings carry createdAt 0, so any รายรับ keyed in by hand that
  // day sits above them — which is also the row the owner just typed.
  return rows.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      b.kind.localeCompare(a.kind) ||
      a.shop.localeCompare(b.shop) ||
      (b.createdAt || 0) - (a.createdAt || 0)
  );
}

// Month totals for the header strip. Works on either summaryRows or ledgerRows —
// both carry { kind, amount } and both add up to the same month.
export function summaryTotals(rows) {
  const income = rows.filter((r) => r.kind === 'income').reduce((n, r) => n + r.amount, 0);
  const expense = rows.filter((r) => r.kind === 'expense').reduce((n, r) => n + r.amount, 0);
  return { income, expense, profit: income - expense };
}

// The working day before the one in progress, for the KPI comparison line.
export function yesterdayKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return workdayKey(d);
}
