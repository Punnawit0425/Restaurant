// ---------------------------------------------------------------------------
// Expense bookkeeping
// ---------------------------------------------------------------------------
// The owner records every outgoing (ingredients, wages, rent, bills...) against
// one of the two shops. An expense is stored as:
//
//   { id, date: 'YYYY-MM-DD', shop: 'day' | 'night', category, amount, note, createdAt }
//
// `date` is a plain local calendar day, NOT a timestamp: an expense belongs to
// the day the owner says it does, and must not shift when read in another
// timezone (which is exactly what storing an epoch would do). `createdAt` keeps
// the real entry time, only for ordering entries made on the same day.
// ---------------------------------------------------------------------------

// The two shops, keyed by the shift they trade in. The ids match an order's
// `type`/shift so revenue and expenses can be totalled per shop later.
export const SHOPS = [
  { id: 'day', label: 'ตู้กับข้าวบ้านยาย' },
  { id: 'night', label: 'เรินเก่า' },
];

export function shopLabel(id) {
  return SHOPS.find((s) => s.id === id)?.label || id;
}

// Fixed category list for the dropdown. 'อื่น ๆ' is the catch-all — the note
// field is where the owner explains it.
export const EXPENSE_CATEGORIES = [
  'ค่าวัตถุดิบ',
  'ค่าอุปกรณ์',
  'ค่าแรงพนักงาน',
  'ค่าเช่าที่',
  'ค่าน้ำ',
  'ค่าไฟ',
  'อื่น ๆ',
];

// The same book also holds hand-keyed INCOME: money that came in without ever
// passing through a bill, so nothing in `orders` knows about it — a catered
// order settled outside the app, a deposit for a party booking, a bag of rice
// sold over the counter. Stored alongside the outgoings with `kind: 'income'`.
// Two is enough: what this mostly is, and everything else. The note field is
// where an 'อื่น ๆ' gets explained. (Entries already saved under a category that
// is no longer offered keep it — the category is stored on the entry, so the
// ledger and the export still read back exactly what was filed.)
export const INCOME_CATEGORIES = [
  'รายรับนอกบิล',
  'อื่น ๆ',
];

// Which side of the book an entry sits on. Every row written before the รายรับ
// form existed carries no `kind` at all, and every one of those is an outgoing
// — so anything not explicitly marked income is an expense.
export function entryKind(e) {
  return e?.kind === 'income' ? 'income' : 'expense';
}

export function categoriesFor(kind) {
  return kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

// Today as 'YYYY-MM-DD' in LOCAL time. (toISOString() would return UTC and so
// roll over to tomorrow during the night shift, filing bills under the wrong day.)
export function todayKey(now = new Date()) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

export const THAI_MONTHS_FULL = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

// 'YYYY-MM-DD' -> '18 ก.ค. 2569' (Buddhist era, as the owner reads dates).
export function formatThaiDate(dateKey) {
  const [y, m, d] = (dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return dateKey || '';
  return `${d} ${THAI_MONTHS_SHORT[m - 1]} ${y + 543}`;
}

const THAI_WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

// 'YYYY-MM-DD' -> 'จันทร์ 18 ก.ค. 2569'. The weekday is taken from the key's
// own calendar date (local midnight), so no timezone can shift it a day.
export function formatThaiDateWithWeekday(dateKey) {
  const [y, m, d] = (dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return dateKey || '';
  return `${THAI_WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${formatThaiDate(dateKey)}`;
}

// Money in the book is kept to satang: 2 decimal places. Rounding on the way
// in (and on sums, which float arithmetic leaves as 0.30000000000000004) keeps
// the ledger, the totals and the Excel export agreeing to the last satang.
export function roundBaht(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// 1234.5 -> '1,234.50'. Always two places so the amount column lines up.
export function formatBaht(n) {
  return roundBaht(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Sum the OUTGOINGS in a list of ledger entries, tolerating entries whose
// amount never parsed. Hand-keyed income shares the list and is skipped here.
export function sumExpenses(list) {
  return (list || [])
    .filter((e) => entryKind(e) === 'expense')
    .reduce((n, e) => n + (Number(e?.amount) || 0), 0);
}
