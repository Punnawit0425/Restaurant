// ---------------------------------------------------------------------------
// ย้ายโต๊ะ — keeping a diner's phone pointed at their own bill
// ---------------------------------------------------------------------------
// A diner's phone is pinned to the table number printed on the QR it scanned.
// When staff move that bill to another table (or merge it into one), the phone
// would stop matching its own order — so it follows the bill instead.
//
// Two pieces of memory make that work, and they answer different questions:
//
//   seen   — the ids of bills this phone has watched at its own table. This is
//            what makes following SAFE: the next group seated at the old table
//            has never seen the previous group's bill, so they are never
//            dragged along with it.
//   follow — { from, to, billId }: the resulting redirection, stored so a
//            reload lands on the right table on the FIRST paint instead of
//            re-deriving it after the order list arrives.
//
// The decision itself is kept pure here (no React, no localStorage) so it can be
// tested directly; App.jsx only loads/saves the two records around it.
// ---------------------------------------------------------------------------

import { workdayKey } from './shift';

export const TABLE_FOLLOW_KEY = 'tableFollow';
export const SEEN_BILLS_KEY = 'seenBills';

export function readTableFollow() {
  try {
    const f = JSON.parse(localStorage.getItem(TABLE_FOLLOW_KEY) || 'null');
    if (!f || !Number.isInteger(Number(f.to)) || !f.billId) return null;
    // A redirection never outlives the shop day it was made on. Without this a
    // phone that was moved yesterday would still be aiming at yesterday's table
    // when it scans the same QR today.
    if (f.day && f.day !== workdayKey()) {
      clearSeating();
      return null;
    }
    return { from: Number(f.from), to: Number(f.to), billId: f.billId, day: f.day };
  } catch {
    return null;
  }
}

// Forget everything this phone knows about its seating: it becomes a brand-new
// phone at whatever table its QR says. Used by the "ไม่ใช่บิลของคุณ?" reset, and
// whenever the old table is clearly occupied by somebody else.
export function clearSeating() {
  localStorage.removeItem(TABLE_FOLLOW_KEY);
  localStorage.removeItem(SEEN_BILLS_KEY);
}

export function writeTableFollow(follow) {
  if (follow) localStorage.setItem(TABLE_FOLLOW_KEY, JSON.stringify(follow));
  else localStorage.removeItem(TABLE_FOLLOW_KEY);
}

export function readSeenBills() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_BILLS_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function writeSeenBills(seen) {
  localStorage.setItem(SEEN_BILLS_KEY, JSON.stringify([...seen]));
}

// The table a scanned QR should actually show: the number in the link, unless a
// stored follow says that exact table has been moved elsewhere. Used by the very
// first render, before any order data exists.
export function tableForScan(scanTable, follow = readTableFollow()) {
  return follow && follow.from === Number(scanTable) ? follow.to : scanTable;
}

// Where this phone belongs, given the current orders.
//
//   orders      every order known to the app (any status)
//   currentTable the table the phone is showing right now
//   scanTable   the table number in its QR link (the anchor it can fall back to)
//   seen        Set of bill ids this phone has watched (mutated: ids are added
//               for bills at the current table and dropped once they close)
//   follow      the stored redirection, or null
//
// Returns { table, follow, moved } — `moved` is true only when this call is the
// one that discovers the change, so the caller knows whether to announce it.
export function resolveSeating({ orders, currentTable, scanTable, seen, follow }) {
  const open = (orders || []).filter(o => o.status !== 'paid' && o.status !== 'cancelled');
  // A bill survives a รวมบิล merge under the id of whichever bill swallowed it,
  // so its old id stays reachable through `absorbedIds`.
  const alive = (id) => open.some(o => o.id === id || (o.absorbedIds || []).includes(id));

  let table = currentTable;
  let nextFollow = follow;
  const mineById = (o) => seen.has(o.id) || (o.absorbedIds || []).some(id => seen.has(id));

  // 1. Retire a follow whose bill has closed: the phone goes back to being just
  //    the QR it scanned, ready for the next group at that table.
  if (nextFollow && !alive(nextFollow.billId)) {
    nextFollow = null;
    if (scanTable != null) table = scanTable;
  }

  // 1a. Drop a redirection no bill actually backs up. An earlier build followed
  //     ANY known bill that turned up under another number, which quietly
  //     redirected a phone to whichever table it happened to remember a bill at
  //     — and then wrote that mistake down. Re-checking the stored follow here
  //     means such a record heals itself on the next load instead of having to
  //     be cleared by hand.
  if (nextFollow) {
    const target = open.find(o =>
      o.id === nextFollow.billId || (o.absorbedIds || []).includes(nextFollow.billId)
    );
    const backed = target && (
      (target.absorbedIds || []).some(id => seen.has(id) || id === nextFollow.billId) ||
      (target.movedFrom || []).map(String).includes(String(nextFollow.from))
    );
    if (target && !backed) {
      nextFollow = null;
      if (scanTable != null) table = scanTable;
    }
  }

  // 1b. Somebody else is now sitting at the table this QR belongs to — there is
  //     an open bill there that this phone has never seen. The redirection is
  //     over: whoever is holding this phone is at the scanned table, not at the
  //     one the old group moved to. This is what stops a moved bill from
  //     capturing the NEXT customer who scans the same QR on the same device.
  if (nextFollow && scanTable != null) {
    const strangerAtScan = open.some(o =>
      String(o.table) === String(scanTable) && !mineById(o)
    );
    if (strangerAtScan) {
      nextFollow = null;
      seen.clear();
      table = scanTable;
      return { table, follow: null, moved: false };
    }
  }

  // 2. Forget ids no longer reachable from any open bill — a settled bill must
  //    never be able to pull a later customer anywhere.
  for (const id of [...seen]) {
    if (!alive(id)) seen.delete(id);
  }

  // 3. Remember the bills sitting at this table right now. This is the record
  //    that later proves a moved bill is ours.
  const here = open.filter(o => String(o.table) === String(table));
  here.forEach(o => seen.add(o.id));
  if (here.length) return { table, follow: nextFollow, moved: false };

  // 4. Nothing here: if one of our own bills turned up under another table
  //    number, that is where we have been re-seated — but only when the bill
  //    itself says it was moved out of where we are. "I know this bill and it is
  //    somewhere else" is NOT enough: a phone that still remembers an open bill
  //    at โต๊ะ 1 would then be dragged to โต๊ะ 1 by every other table it opened,
  //    since an empty table always falls through to this step.
  //
  //    The bill carries the proof either way:
  //      absorbedIds — รวมบิล folded our bill into this one;
  //      movedFrom   — ย้ายโต๊ะ stamps the number it was moved off
  //                    (StaffView.moveBillTo), so a 1→7→9 chain still matches.
  const isMine = (o) => seen.has(o.id) || (o.absorbedIds || []).some(id => seen.has(id));
  const movedOffUs = (o) => {
    if ((o.absorbedIds || []).some(id => seen.has(id))) return true;
    const from = (o.movedFrom || []).map(String);
    return from.includes(String(table)) || (scanTable != null && from.includes(String(scanTable)));
  };
  const found = open.find(o => isMine(o) && String(o.table) !== String(table) && movedOffUs(o));
  const to = Number.parseInt(found?.table, 10);
  if (!Number.isInteger(to)) return { table, follow: nextFollow, moved: false };

  return {
    table: to,
    // Anchored to the table this phone SCANNED, so a second move (1→7→9) only
    // updates where that one QR now points. `day` expires it overnight.
    follow: { from: Number(scanTable ?? table), to, billId: found.id, day: workdayKey() },
    moved: true,
  };
}
