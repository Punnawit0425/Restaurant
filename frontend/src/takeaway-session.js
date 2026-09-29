// ---------------------------------------------------------------------------
// สั่งกลับบ้าน — this phone's takeaway session
// ---------------------------------------------------------------------------
// A table QR names its bill by itself: every phone at โต๊ะ 5 orders onto bill 5.
// The takeaway QR is one sticker for everybody, so the bill has to be named by
// the PHONE instead — 1 เครื่อง / 1 เซสชัน = 1 บิล. This is that name: a random id
// the phone stamps on each order as `takeawaySession` (see takeawayBillIndex in
// orders.js).
//
// localStorage, not sessionStorage (where the seat lives): a customer who
// ordered, closed the tab and scanned again to add a drink is still the same
// customer, and must land back on the same กลับบ้าน#N rather than open a second
// bill. Once that bill is paid, the next order from this phone simply finds no
// open bill under the id and opens a new one — so the id itself never needs
// rotating. It is dropped at the end of the working day, like every other piece
// of seating memory.
// ---------------------------------------------------------------------------

import { workdayKey } from './shift';

export const TAKEAWAY_SESSION_KEY = 'takeawaySession';

// Held in memory too, so a phone whose storage refuses writes still keeps ONE
// id for as long as the page is open instead of minting a new bill per call.
let current = null;

// This phone's session id for today, created on first use.
export function takeawaySessionId() {
  const day = workdayKey();
  try {
    const rec = JSON.parse(localStorage.getItem(TAKEAWAY_SESSION_KEY) || 'null');
    if (rec?.id && rec.day === day) {
      current = rec;
      return rec.id;
    }
  } catch {
    /* unreadable record — fall through */
  }
  if (current?.day === day) return current.id;
  const id = 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  current = { id, day };
  try {
    localStorage.setItem(TAKEAWAY_SESSION_KEY, JSON.stringify(current));
  } catch {
    // Private-mode quota errors: the id still works for as long as the page is
    // open, it just will not survive a reload.
  }
  return id;
}
