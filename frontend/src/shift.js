// ---------------------------------------------------------------------------
// Shift helpers (day / night)
// ---------------------------------------------------------------------------
// An order's `type` records which *shift* it was placed in, taken from the
// menu/theme it was ordered from — a day-menu order is 'day', a night-menu
// order is 'night' — so a day order always shows on the day board and a night
// order on the night board, no matter the wall clock. This lets staff screen
// the order board by shift and get notified only for the shift they work.
//
// The clock helpers below decide the shift for a table QR scan (a plain
// ?table=N link opens whichever shop is running right now), and are also the
// fallback for legacy orders saved before `type` existed:
//
//   day   = 06:00–16:59
//   night = 17:00–05:59
// ---------------------------------------------------------------------------

// The line is drawn on Bangkok time, not the device clock. The shop is in
// Thailand, but the phone scanning the QR need not be set to Thai time — a
// tourist's handset still on its home timezone would otherwise be handed the
// day menu at 20:00 Bangkok, and its order would land on the wrong board.
const BANGKOK_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Bangkok',
  hour: 'numeric',
  // h23 explicitly: `hour12: false` renders midnight as "24" on some engines.
  hourCycle: 'h23',
});

// The hour (0–23) it is in Thailand at the given moment.
export function bangkokHour(date = new Date()) {
  return Number(BANGKOK_HOUR.format(date));
}

// The calendar date in Thailand at the given moment, as 'YYYY-MM-DD'. ('en-CA'
// is the locale whose short date format IS that shape.) Pinned to Bangkok for
// the same reason the hour is: the phone reading a number must not be able to
// move which day that number belongs to.
const BANGKOK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// The two ends of the day shift, in Bangkok hours. The day side opens with the
// working day (06:00, the same boundary every date in the app rolls over on) and hands
// over to the night side at 17:00 — so these two constants, not a literal, are
// what every "which shop is open" question resolves to.
export const DAY_SHIFT_START_HOUR = 6;
export const DAY_SHIFT_END_HOUR = 17;

// Which shift does a given Date fall in?
export function shiftFromDate(date) {
  const hour = bangkokHour(date);
  return hour >= DAY_SHIFT_START_HOUR && hour < DAY_SHIFT_END_HOUR ? 'day' : 'night';
}

// The shift right now — used when stamping a brand-new order.
export function shiftNow() {
  return shiftFromDate(new Date());
}

// --- The working day ----------------------------------------------------------
// A shop day is NOT a calendar day: the night side closes after midnight, so a
// shift that opens at 20:00 and closes at 01:30 has to land on ONE date. The
// day therefore runs 06:00 today → 06:00 tomorrow, and everything before 06:00
// counts as the previous date — the same boundary the day shift opens on.
//
// The owner's takings are counted on this same day, not the calendar one (see
// orderDateKey in stats.js): a bill settled at 01:00 was earned on the evening
// that is still running, so the dashboard rolls over at 06:00 with the shift.
export const WORKDAY_START_HOUR = DAY_SHIFT_START_HOUR;

// The date key ('YYYY-MM-DD') of the working day a moment belongs to. Rolling
// the moment back by the start hour turns "06:00-based day" into a plain
// calendar date, so 02:00 on the 27th keys as the 26th and stays there until
// 06:00 on the 27th — which is the ONE rule every date in this app follows.
//
// Read in Bangkok, not on the device clock. This used to shift the hours with
// setHours() and then read the local date off the result, which meant the day
// rolled over at 06:00 *wherever the reader happened to be*: a phone left on
// another timezone (or a server container defaulting to UTC, which is what
// node:alpine does) put the same bill on a different day than the till did.
export function workdayKey(at = new Date()) {
  const ms = (at instanceof Date ? at : new Date(at)).getTime();
  return BANGKOK_DATE.format(new Date(ms - WORKDAY_START_HOUR * 60 * 60 * 1000));
}

// A key that changes whenever EITHER the working day rolls over OR the shift
// flips day↔night — e.g. '2026-08-08-day', then '2026-08-08-night' at 17:00,
// then '2026-08-09-day' at 06:00. The whole night side (17:00 → 05:59) shares
// one key because workdayKey already folds after-midnight back onto the same
// date. The เช็กบิล lock is scoped to this: a phone that paid on the day side
// unlocks itself once the shop turns to the night side (or the next working day
// begins), so a lunch group returning for dinner scans the same table back in —
// while the group that just paid stays locked for the rest of the current shift.
export function shiftKey(at = new Date()) {
  const d = new Date(at);
  return `${workdayKey(d)}-${shiftFromDate(d)}`;
}

// Read an order's shift, tolerating legacy orders saved before `type` existed:
// fall back to the shift implied by their createdAt timestamp, and finally to
// 'day' if even that is missing.
export function orderShift(order) {
  if (order?.type === 'day' || order?.type === 'night') return order.type;
  if (order?.createdAt) return shiftFromDate(new Date(order.createdAt));
  return 'day';
}
