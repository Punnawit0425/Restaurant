// ---------------------------------------------------------------------------
// Invoice number generator
// ---------------------------------------------------------------------------
// Builds the human-readable bill number stamped on an order the moment it is
// paid, in the form:
//
//     YYMMDD-D/N-0000
//        │     │   └── 4-digit running number, zero-padded, restarts each day
//        │     │       and is counted SEPARATELY per shift
//        │     └────── 'D' for a day-shift bill, 'N' for a night-shift bill
//        └──────────── today's date (2-digit year, month, day)
//
// e.g. the first day bill on 17 Jul 2026 → 260717-D-0001, the next → 260717-D-0002,
// and the first night bill that day → 260717-N-0001.
//
// The running number is derived from how many bills already carry an invoiceNo
// with the SAME date+shift prefix, so it needs no server-side counter and stays
// correct across restarts (the paid orders that hold the numbers are never
// deleted). Legacy orders that predate invoice numbers simply have none and are
// ignored by the count.
// ---------------------------------------------------------------------------

import { orderShift, workdayKey } from './shift';

// The YYMMDD-D/N- prefix an order's invoice number would start with today.
//
// The date is the WORKING day (06:00 → 06:00), not the calendar one. It used to
// be the calendar date, which broke the night shift in two: a bill settled at
// 00:30 was stamped with tomorrow's date while the dashboard counted its money
// on the evening that earned it, and the 4-digit counter restarted at midnight
// in the middle of the shift — two `N-0001` bills in one night.
function invoicePrefix(order, now = new Date()) {
  const yymmdd = workdayKey(now).slice(2).replace(/-/g, '');
  const shiftLetter = orderShift(order) === 'night' ? 'N' : 'D';
  return `${yymmdd}-${shiftLetter}-`;
}

// Generate the next invoice number for `order`, given the full `orders` list it
// will live in. Counts existing invoice numbers sharing the same date+shift
// prefix and returns prefix + (count + 1), zero-padded to 4 digits.
//
// When settling several bills at once, pass a working list that already
// includes the invoice numbers assigned earlier in the batch, so each bill gets
// a distinct, sequential number (see handleClearAndPay in StaffView).
export function generateInvoiceNo(order, orders, now = new Date()) {
  const prefix = invoicePrefix(order, now);
  const used = (orders || []).reduce(
    (n, o) => (typeof o?.invoiceNo === 'string' && o.invoiceNo.startsWith(prefix) ? n + 1 : n),
    0
  );
  const running = String(used + 1).padStart(4, '0');
  return `${prefix}${running}`;
}

// ---------------------------------------------------------------------------
// The bill's short number — the '#' on the card, e.g. '#69_0741'
// ---------------------------------------------------------------------------
// Different thing from the invoice number above: this is what staff call a bill
// across the room ("เก็บ #69_0741 ด้วย"), so it is short, and it restarts every
// year rather than every shift.
//
//     #69_0741
//      │   └── running number within that year, zero-padded to 4
//      └────── last two digits of the พ.ศ. year
//
// It used to be `'#' + (orders.length + 1)` — a count of every bill the shop had
// ever taken, climbing forever with no year in it.

// The 2-digit พ.ศ. year of a moment's WORKING day. The year therefore turns over
// at 06:00 on 1 January, with the day — a bill rung up at 02:00 on New Year's
// Day belongs to the year whose evening is still being served.
export function beYear(now = new Date()) {
  return String(Number(workdayKey(now).slice(0, 4)) + 543).slice(-2);
}

// Which year an existing order counts against.
function orderBeYear(order) {
  if (order?.createdAt) return beYear(new Date(order.createdAt));
  // No timestamp (very old rows): read the year back off the number itself.
  const m = /^#(\d{2})_/.exec(order?.no || '');
  return m ? m[1] : null;
}

// The next '#' for a new bill. Counts the bills already belonging to this พ.ศ.
// year BY THEIR DATE, not by the shape of their number — so the count carries
// straight on through the change of scheme instead of restarting at 1, and
// restarts on its own at the new year.
export function generateOrderNo(orders, now = new Date()) {
  const yy = beYear(now);
  const used = (orders || []).reduce((n, o) => (orderBeYear(o) === yy ? n + 1 : n), 0);
  return `#${yy}_${String(used + 1).padStart(4, '0')}`;
}
