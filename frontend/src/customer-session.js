// ---------------------------------------------------------------------------
// ปิดโต๊ะ = จบเซสชันของลูกค้า — clearing a diner's session once the bill is paid
// ---------------------------------------------------------------------------
// A diner's phone has no login: it is "in" a table's session simply by holding
// the QR link. That is fine while they are eating, but the moment staff take
// payment the bill is closed and that phone must stop being a way into the
// table — otherwise the group that just left can keep the page open (or reload
// the same link) and drop food onto a table they are no longer sitting at.
//
// So payment ends the session on the phone as well as on the board:
//
//   1. the phone notices that a bill IT watched has been settled ('paid'),
//   2. it says thank-you for THANKS_MS, then locks itself out of the menu,
//   3. every trace of the seating (follow + seen bills + cart) is cleared.
//
// The lock is remembered per SEAT (the table whose QR was scanned) and lasts
// the current SHIFT (day/night), so re-opening or re-scanning the same link
// lands back on the locked screen instead of a fresh menu — until the shop turns
// to the night side or the next working day begins, when it clears itself and
// the same phone may scan the same table again. It is deliberately device-local:
// the next group sits down with their OWN phones, which have never seen this
// record, and they scan in exactly as normal.
//
// Kept out of React (like table-follow.js) so the rules can be read and tested
// on their own; App.jsx only loads/saves the record around them.
// ---------------------------------------------------------------------------

import { shiftKey, workdayKey } from './shift';

export const CLOSED_SESSION_KEY = 'closedSession';

// ---------------------------------------------------------------------------
// ที่นั่งของแท็บนี้ — remembering the scan without leaving it in the URL
// ---------------------------------------------------------------------------
// The QR link (…/?table=5) is what turns a phone into a customer, but leaving it
// in the address bar hands the diner a way back in: the ordering page sits in
// the browser's history and its back button, ready to be re-opened after the
// bill is settled. So the link is read once and then wiped off the URL, and the
// seat it named is kept here instead.
//
// sessionStorage, NOT localStorage, and that is the whole design:
//   * it survives a reload, so a diner refreshing mid-meal stays in their
//     session even though the URL no longer says which table they are at;
//   * it dies with the browser tab, so a phone (or the shop's own handset) that
//     scanned once does not keep opening into the customer menu forever —
//     closing the tab makes it an ordinary visitor again.
// The lock written at เช็กบิล time is the opposite case and stays in
// localStorage: it MUST outlive the tab, or closing it would be a way around.
export const SEAT_KEY = 'tableSeat';

// The seat this tab is sitting at, or null. Expires with the working day, like
// every other piece of seating memory. A takeaway scan is a seat with no table
// ({ takeaway: true, table: null }) — which bill it orders onto is decided by
// the phone's takeaway session, not by a number on the QR.
export function readSeat() {
  try {
    const seat = JSON.parse(sessionStorage.getItem(SEAT_KEY) || 'null');
    if (!seat || (!seat.takeaway && !Number.isInteger(Number(seat.table)))) return null;
    if (seat.day && seat.day !== workdayKey()) {
      clearSeat();
      return null;
    }
    if (seat.takeaway) return { table: null, takeaway: true, shift: seat.shift || null, day: seat.day };
    return { table: Number(seat.table), shift: seat.shift || null, day: seat.day };
  } catch {
    return null;
  }
}

// Take the seat named by a QR scan. `shift` is 'day'/'night' only for the
// locked ?table-day / ?table-night links; a plain ?table stores null so each
// load keeps asking the clock, exactly as it did when the link stayed in the URL.
export function writeSeat({ table, shift = null, takeaway = false }) {
  try {
    sessionStorage.setItem(SEAT_KEY, JSON.stringify({
      ...(takeaway ? { takeaway: true, table: null } : { table: Number(table) }),
      shift,
      day: workdayKey(),
      arrivedAt: Date.now(),
    }));
  } catch {
    // Private-mode quota errors: the app still works, it just cannot resume
    // after a reload.
  }
}

export function clearSeat() {
  try {
    sessionStorage.removeItem(SEAT_KEY);
  } catch {
    /* nothing to clear */
  }
}

// Wipe the table link off the address bar without navigating: same page, same
// scroll, but the history entry the QR created now points at a bare URL. This
// is what stops the diner from tapping back (or picking the link out of their
// history) into an ordering page they have already paid for.
export function stripTableParams(loc = window.location, history = window.history) {
  const url = new URL(loc.href);
  const before = url.search;
  ['table', 'table-day', 'table-night', 'takeaway'].forEach((k) => url.searchParams.delete(k));
  if (url.search === before) return;
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

// How long the thank-you screen stays before the phone is locked out. Long
// enough for the diner to see what they paid, short enough that a phone left on
// the table is already locked by the time the next group sits down.
export const THANKS_MS = 10000;

// Does a stored lock belong to the seat this phone is looking at? Matched on
// the SCANNED table (the number printed on the QR), because that is the anchor
// that survives a ย้ายโต๊ะ — a bill moved 1 → 7 still locks the QR at table 1.
// Falls back to the table the group was sitting at when the bill was settled.
export function isSameSeat(closed, scanTable) {
  if (!closed) return false;
  const seat = closed.scanTable ?? closed.table;
  return String(seat) === String(scanTable);
}

// The stored lock, or null. A lock never outlives the SHIFT it was made in: come
// the night side (or the next working day) the phone is just a phone again, and
// the stale record would otherwise keep a returning group out of a table they
// have every right to scan. Scoping to the shift rather than the whole working
// day is what lets a lunch group that paid at noon scan back in when they return
// for dinner — day → night is a new shift. Expiry is self-healing: the dead
// record is dropped as it is read.
export function readClosedSession() {
  try {
    const rec = JSON.parse(localStorage.getItem(CLOSED_SESSION_KEY) || 'null');
    if (!rec || !rec.closedAt) return null;
    // Anything not stamped with the CURRENT shift key is stale — a previous
    // shift's lock, or a pre-shift-scoping record that only carried `day`. Either
    // way the phone must not be held past the shift it paid in, so it is dropped.
    if (rec.shiftKey !== shiftKey()) {
      clearClosedSession();
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export function writeClosedSession(rec) {
  localStorage.setItem(CLOSED_SESSION_KEY, JSON.stringify(rec));
}

export function clearClosedSession() {
  localStorage.removeItem(CLOSED_SESSION_KEY);
}

// The settled bills that belong to THIS phone: paid bills whose id is one this
// phone watched open at its own table. `absorbedIds` keeps a bill reachable
// after a รวมบิล merge, exactly as the table-follow rules rely on.
//
// Matching on seen ids is what keeps the lock honest: a phone is only ever
// locked out by the closing of a bill it actually sat with, never by the table
// next door settling up.
export function settledBills(orders, seen) {
  if (!seen || seen.size === 0) return [];
  return (orders || []).filter(o =>
    o.status === 'paid' && (seen.has(o.id) || (o.absorbedIds || []).some(id => seen.has(id)))
  );
}

// Build the lock record if this phone's bill has just been settled, else null.
// `table` is where the phone is showing, `scanTable` the number on its QR.
export function closedSessionFor({ orders, seen, table, scanTable, now = Date.now() }) {
  const settled = settledBills(orders, seen);
  if (settled.length === 0) return null;
  return {
    table: settled[0].table ?? table,
    scanTable: scanTable ?? null,
    // Every bill of this group's — a table that split into two bills paid both,
    // and the thank-you screen should name the whole amount they handed over.
    total: settled.reduce((sum, o) => sum + (o.total || 0), 0),
    billIds: settled.map(o => o.id),
    payMethod: settled[0].payMethod || null,
    closedAt: now,
    // Scoped to the shift it closed in, not the whole working day: the lock lifts
    // when the shop turns to the night side or the next day begins (readClosedSession).
    shiftKey: shiftKey(now),
  };
}

// Which of the two closed screens to show: the thank-you note, or the lock.
export function sessionPhase(closed, now = Date.now()) {
  if (!closed) return null;
  return now - closed.closedAt < THANKS_MS ? 'thanks' : 'locked';
}
