// ---------------------------------------------------------------------------
// Reconciling order writes — why a table's newest round used to vanish
// ---------------------------------------------------------------------------
// Every tab writes `orders` by PUTting the WHOLE array it currently holds. A
// table that orders again does not get a new bill: mergeOrder folds the new
// round into the open bill, keeping its id. So when โต๊ะ 5 orders round 2 while
// a staff tablet is still holding the round-1 copy (asleep, SSE dropped, or a
// push swallowed by the echo guard), the next thing that tablet saves — any tap
// on any table — sends bill 5 back WITHOUT round 2, and the server used to take
// it as the truth. The same happened between two phones at one table, each
// adding a round on top of its own copy. Round 2 was simply gone, from memory,
// data.json and Postgres alike.
//
// The fix is to know which rounds a writer had actually SEEN. Every bill carries
// `roundKeys`: the `roundAt` stamp of each round the server has ever held on it.
// Tabs never touch the field, they just carry it along with the rest of the
// bill, so a stale copy carries a stale list. A line the server holds that the
// write lacks is then either:
//   * from a round listed in the write's `roundKeys` — the writer saw it and
//     removed it on purpose (แก้ไขบิล), so it stays removed; or
//   * from a round the writer never saw — it was lost, not deleted, and is put
//     back.
// Bills written before this existed have no `roundKeys`; for them the newest
// `roundAt` on the write stands in, which catches the common case (a newer round
// than anything the writer had) without resurrecting deliberate deletions.
// ---------------------------------------------------------------------------

const isDiscountItem = (it) => it?.kind === 'discount';
const isClosed = (o) => o?.status === 'paid' || o?.status === 'cancelled';
const lineTotal = (it) => ((it.price || 0) + (it.addonCost || 0)) * (it.qty || 0);
const itemRound = (it) => it?.round || 1;

// The round stamps present on a bill's lines. Discount lines carry none.
function roundAtsOf(items) {
  return (items || [])
    .filter((it) => !isDiscountItem(it) && it?.roundAt != null)
    .map((it) => it.roundAt);
}

// Every round the server knows this bill has had.
function roundKeysOf(order) {
  const listed = Array.isArray(order?.roundKeys) ? order.roundKeys : [];
  return [...new Set([...listed, ...roundAtsOf(order?.items)])];
}

// Same roll-up as deriveBillStatus in frontend/src/orders.js ('received' and
// 'in_kitchen' both read as not-yet-started, so which of the two a legacy 'new'
// line would normalise to does not matter here).
function deriveBillStatus(items) {
  const list = items || [];
  if (list.length === 0) return 'new';
  const states = list.map((it) => (it?.status === 'cooking' ? 'in_progress' : it?.status || 'new'));
  if (states.every((s) => s === 'served')) return 'served';
  if (states.some((s) => s === 'new' || s === 'received' || s === 'in_kitchen')) return 'new';
  return 'cooking';
}

// Re-total a bill whose lines changed, re-striking a ส่วนลด over the new
// subtotal the same way withDiscount does on the client: a percentage follows
// the subtotal, a baht amount stays put (capped at the subtotal), and the
// discount line stays last.
function retotal(order, items) {
  const kept = items.filter((it) => !isDiscountItem(it));
  const discount = items.find(isDiscountItem);
  const base = kept.reduce((sum, it) => sum + lineTotal(it), 0);
  let lines = kept;
  if (discount) {
    const amount = discount.mode === 'baht'
      ? Math.min(Math.round(Math.abs(Number(discount.price) || 0)), base)
      : Math.round(base * Math.min(Number(discount.percent) || 0, 100) / 100);
    lines = [...kept, {
      ...discount,
      price: -amount,
      round: kept.reduce((m, it) => Math.max(m, itemRound(it)), 1),
    }];
  }
  return {
    ...order,
    items: lines,
    total: lines.reduce((sum, it) => sum + lineTotal(it), 0),
    status: deriveBillStatus(lines),
  };
}

// Join two ' | '-separated bill notes without repeating a part.
function joinNotes(a, b) {
  const parts = [...String(a || '').split(' | '), ...String(b || '').split(' | ')]
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(' | ');
}

// Put `lost` lines back onto `order` as rounds after its current last one.
function appendRounds(order, lost, from) {
  const top = (order.items || []).reduce((m, it) => Math.max(m, itemRound(it)), 1);
  const stamps = [...new Set(lost.map((it) => it.roundAt))].sort((a, b) => a - b);
  const renumbered = lost.map((it) => ({ ...it, round: top + 1 + stamps.indexOf(it.roundAt) }));
  const restored = retotal(order, [...(order.items || []), ...renumbered]);
  return {
    ...restored,
    // The restored round is newer than anything the writer had.
    time: from.time || restored.time,
    note: joinNotes(order.note, from.note),
  };
}

// Stamp `roundKeys` on an open bill. Closed bills never take another round.
export function withRoundKeys(order) {
  if (!order || typeof order !== 'object' || isClosed(order)) return order;
  return { ...order, roundKeys: roundKeysOf(order) };
}

// The lines of `stored` that `incoming` dropped without ever having seen them.
function lostLines(stored, incoming) {
  const present = new Set((incoming.items || []).map((it) => it?.uid).filter(Boolean));
  // A writer that still has any line of a round has seen that round, even if
  // the round is younger than the `roundKeys` it last received (its own write,
  // not yet echoed back).
  const seen = Array.isArray(incoming.roundKeys) ? new Set(roundKeysOf(incoming)) : null;
  const newestSeen = Math.max(-Infinity, ...roundAtsOf(incoming.items));
  return (stored.items || []).filter((it) => {
    if (isDiscountItem(it) || it?.roundAt == null) return false;
    if (it.uid && present.has(it.uid)) return false;
    return seen ? !seen.has(it.roundAt) : it.roundAt > newestSeen;
  });
}

// A signed-in write of one bill the server already holds. Staff may change
// anything, but they cannot erase a round they never saw.
function reconcileStaffBill(stored, incoming) {
  if (isClosed(stored)) return incoming; // voiding / correcting history is theirs
  const lost = lostLines(stored, incoming);
  if (!lost.length) return withRoundKeys({ ...incoming, roundKeys: roundKeysOf(stored).concat(roundKeysOf(incoming)) });
  if (isClosed(incoming)) {
    // Settled from a copy that never showed these lines. The money taken is what
    // it is, so the bill is left as written — but say so loudly, because the
    // table was charged for less than it ordered.
    console.warn(
      `[orders] Bill ${stored.id} (โต๊ะ ${stored.table}) was closed from a stale copy missing ` +
      `${lost.length} line(s): ${lost.map((it) => `${it.name} x${it.qty}`).join(', ')}`
    );
    return incoming;
  }
  console.warn(`[orders] Restored ${lost.length} line(s) a stale write dropped from bill ${stored.id} (โต๊ะ ${stored.table})`);
  const restored = appendRounds(incoming, lost, stored);
  return withRoundKeys({ ...restored, roundKeys: roundKeysOf(stored).concat(roundKeysOf(incoming)) });
}

// A session-less (diner) write of one open bill. A diner can only ever do two
// things to a bill: add a round, or ask to เช็กบิล. So the server's copy stays
// the base — which keeps staff's item statuses, edits and table moves from being
// reverted by a phone holding an older copy — and only those two changes are
// taken from the phone.
export function reconcileCustomerBill(stored, incoming) {
  const known = new Set(roundKeysOf(stored));
  const added = (incoming.items || []).filter(
    (it) => !isDiscountItem(it) && it?.roundAt != null && !known.has(it.roundAt)
  );

  let next = stored;
  if (added.length) {
    next = appendRounds(stored, added, incoming);
    console.log(`[orders] Bill ${stored.id} (โต๊ะ ${stored.table}) took a new round of ${added.length} line(s)`);
  }
  if (!stored.checkout && incoming.checkout?.stage === 'requested') {
    next = { ...next, checkout: incoming.checkout };
  }
  return withRoundKeys(next);
}

// Rebuild the orders array from a signed-in write. Differences from taking the
// array verbatim:
//   * a bill the server holds but the write lacks is KEPT — a stale tab must not
//     be able to delete a table that sat down after its last update. The only
//     way a bill legitimately leaves the array is รวมบิล (absorbBill), which
//     names it in the surviving bill's `absorbedIds`;
//   * an open bill cannot lose a round the writer never saw (see above).
export function reconcileStaffOrdersWrite(next, prev) {
  const storedById = new Map(prev.filter((o) => o?.id).map((o) => [o.id, o]));
  const absorbed = new Set(next.flatMap((o) => (Array.isArray(o?.absorbedIds) ? o.absorbedIds : [])));
  const written = new Set();

  const orders = next.map((o) => {
    if (!o?.id) return o;
    written.add(o.id);
    const stored = storedById.get(o.id);
    return stored ? reconcileStaffBill(stored, o) : withRoundKeys(o);
  });

  const kept = prev.filter((o) => o?.id && !written.has(o.id) && !absorbed.has(o.id));
  if (kept.length) {
    console.warn(`[orders] Kept ${kept.length} bill(s) a stale write left out: ${kept.map((o) => o.id).join(', ')}`);
  }
  return [...orders, ...kept];
}

// ---------------------------------------------------------------------------
// กลับบ้าน#N — the server has the last word on the number
// ---------------------------------------------------------------------------
// A takeaway phone numbers its new bill from its own copy of the orders
// (nextSingleRoundTable in frontend/src/orders.js). Two customers who scan the
// takeaway QR and order in the same second both hold the same copy, so both
// would pick the same #N. The server sees the writes one at a time, so it
// re-numbers each new takeaway bill against what it actually holds.
//
// Same rule as the client: counted per working day (06:00 → 06:00) AND per
// shift (day 06:00–16:59 / night 17:00–05:59), in Bangkok time — so the run
// restarts at #1 when the day side opens and again when the night side does.
// Paid and cancelled bills still count; reusing a settled #1 would put two
// different กลับบ้าน#1 in the same shift's history.
export const TAKEAWAY_TABLE = 'กลับบ้าน';
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 17;
const BKK_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hourCycle: 'h23' });
const BKK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });

const channelOf = (table) => String(table ?? '').split('#')[0].trim();

function shiftOf(order) {
  if (order?.type === 'day' || order?.type === 'night') return order.type;
  const hour = Number(BKK_HOUR.format(new Date(order?.createdAt || Date.now())));
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? 'day' : 'night';
}

function workdayOf(order) {
  const ms = Number(order?.createdAt) || Date.now();
  return BKK_DATE.format(new Date(ms - DAY_START_HOUR * 60 * 60 * 1000));
}

// Give each new takeaway bill in `added` the next free number after everything
// in `existing` (and after the ones numbered before it in this same write).
export function numberTakeawayOrders(added, existing) {
  const taken = [...existing];
  return added.map((o) => {
    if (channelOf(o?.table) !== TAKEAWAY_TABLE) return o;
    const shift = shiftOf(o);
    const day = workdayOf(o);
    let highest = 0;
    for (const other of taken) {
      if (channelOf(other?.table) !== TAKEAWAY_TABLE) continue;
      if (!other.createdAt || shiftOf(other) !== shift || workdayOf(other) !== day) continue;
      // A legacy bare 'กลับบ้าน' counts as #1, as on the client.
      const n = Number.parseInt(String(other.table).split('#')[1], 10) || 1;
      if (n > highest) highest = n;
    }
    // createdAt is what the count keys on, so a bill must never leave here
    // without one — or the next takeaway in this write would not see it.
    const numbered = { ...o, createdAt: Number(o.createdAt) || Date.now(), table: `${TAKEAWAY_TABLE}#${highest + 1}` };
    taken.push(numbered);
    return numbered;
  });
}

// Drop bills that were folded into another by รวมบิล. The array held in memory
// already lacks them, but Postgres never deletes a row, so without this an
// absorbed bill came back as an open bill on the next restart.
export function dropAbsorbed(orders) {
  const absorbed = new Set(orders.flatMap((o) => (Array.isArray(o?.absorbedIds) ? o.absorbedIds : [])));
  return absorbed.size ? orders.filter((o) => !absorbed.has(o?.id)) : orders;
}
