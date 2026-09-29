// ---------------------------------------------------------------------------
// Order helpers — bill merging & rounds
// ---------------------------------------------------------------------------
// While a table has not checked out yet, every additional order it sends to the
// kitchen is folded into that table's ONE open bill instead of starting a
// separate one. Each batch of items keeps a `round` number so the ticket can
// draw a divider between "the first order" and "ordered more later".
//
// A bill is considered OPEN (mergeable) when it is the same table and not yet
// paid or cancelled — the same predicate the table-status and customer-session
// views use.
//
// It used to require the same SHIFT as well. That stopped being safe once an
// order's shift became the shop clock rather than the menu it was typed from:
// a table seated at 16:50 that orders another round at 17:10 would no longer
// match its own open bill, and the party would be handed two. A bill belongs to
// the shift that OPENED it, and every later round joins it — which is the only
// way a single bill can work, since one bill cannot pay into two shops.
// ---------------------------------------------------------------------------

import { orderShift, workdayKey } from './shift';

// An item with no `round` (placed before this feature, or the very first batch)
// counts as round 1.
export function itemRound(item) {
  return item?.round || 1;
}

// ---------------------------------------------------------------------------
// Non-seated order channels (Grab / กลับบ้าน)
// ---------------------------------------------------------------------------
// A seated table keeps ONE open bill and every later order merges into it as
// the next round — that is right for โต๊ะ 5, where the same people are still
// sitting there.
//
// Delivery and takeaway are not that. Two Grab riders arriving in the same
// minute are two unrelated customers who merely share a "table" name, and
// folding them into one bill mixes their food together. So these channels are
// SINGLE-ROUND: every order opens its own numbered bill — Grab#1, Grab#2 —
// which is what keeps the two apart on the board, on the kitchen ticket and on
// the slip.
//
// Two things deliberately do NOT change:
//   * the items are stamped exactly like a table's, so they join the same
//     name-based batches on the cook's board;
//   * adding to one of these bills afterwards is still possible — but only as
//     a deliberate act through the แก้ไขบิล editor, never silently by a second
//     order arriving.
export const GRAB_TABLE = 'Grab';
export const TAKEAWAY_TABLE = 'กลับบ้าน';
export const SINGLE_ROUND_TABLES = [GRAB_TABLE, TAKEAWAY_TABLE];

// The channel a table value belongs to, or null for a seated table:
//   'Grab' | 'Grab#2' -> 'Grab' ;  'กลับบ้าน#3' -> 'กลับบ้าน' ;  '5' -> null
export function singleRoundBase(table) {
  const base = String(table ?? '').split('#')[0].trim();
  return SINGLE_ROUND_TABLES.includes(base) ? base : null;
}

// True once a channel table already carries its ticket number ('Grab#2'), so a
// second pass never renumbers a bill that has one.
export function isNumberedChannel(table) {
  return !!singleRoundBase(table) && String(table).includes('#');
}

// The next free ticket number for `base`, e.g. 'Grab#3'.
//
// Numbering restarts each working day and is counted per shift, so the night
// side does not continue the day side's run. Paid and cancelled bills still
// count: reusing #1 the moment #1 is settled would put two different Grab#1
// bills in the same day's history, which is exactly the mix-up this is here to
// prevent.
export function nextSingleRoundTable(orders, base, newOrder) {
  const shift = orderShift(newOrder);
  const day = workdayKey(newOrder.createdAt ? new Date(newOrder.createdAt) : new Date());

  let highest = 0;
  for (const o of orders || []) {
    if (singleRoundBase(o.table) !== base) continue;
    if (orderShift(o) !== shift) continue;
    if (!o.createdAt || workdayKey(new Date(o.createdAt)) !== day) continue;
    // A legacy bill saved as plain 'กลับบ้าน' (before numbering existed) counts
    // as #1, so the next one becomes #2 rather than colliding with it.
    const n = Number.parseInt(String(o.table).split('#')[1], 10) || 1;
    if (n > highest) highest = n;
  }
  return `${base}#${highest + 1}`;
}

// How a table reads on screen. A seated table gets the "โต๊ะ" prefix; a channel
// ticket is already self-describing ("Grab #2"), and "โต๊ะ Grab #2" would be a
// contradiction. The stored value stays 'Grab#2' — the space is display only.
export function tableLabel(table) {
  const base = singleRoundBase(table);
  if (!base) return `โต๊ะ ${table}`;
  const n = String(table).split('#')[1];
  return n ? `${base} #${n}` : base;
}

// ---------------------------------------------------------------------------
// สั่งกลับบ้านผ่าน QR — one phone, one bill
// ---------------------------------------------------------------------------
// The takeaway QR is shared by every customer who scans it, so unlike a table
// QR it cannot say which bill an order belongs to. The PHONE does: each one
// holds its own session id (takeaway-session.js), stamped on the order as
// `takeawaySession`. A phone's first order opens a fresh กลับบ้าน#N; every later
// order from the same phone joins that bill as the next round, exactly like a
// table would — while the phone next to it, on the same QR, gets #N+1.
//
// The open bill a takeaway phone is ordering onto, or -1.
export function takeawayBillIndex(orders, session) {
  if (!session) return -1;
  return (orders || []).findIndex(o =>
    o.takeawaySession === session && o.status !== 'paid' && o.status !== 'cancelled'
  );
}

// ---------------------------------------------------------------------------
// Checkout / billing lifecycle (เช็กบิล)
// ---------------------------------------------------------------------------
// While a bill is open a table can keep ordering. Once เช็กบิล starts, the bill
// moves through two stages before it is finally settled (paid):
//   'requested' — the customer tapped เช็กบิล on their phone; ordering is LOCKED
//                 and the staff board shows "โต๊ะ X ขอเช็กบิล" so they know to
//                 print the bill (and grab the ถุงเงิน phone for คนละครึ่ง).
//   'printed'   — staff printed the receipt; only now do the "ประเภทเงินที่ได้รับ
//                 จริง" buttons (เงินสด / สแกน QR / คนละครึ่ง) appear on the card.
// Picking a money type settles the bill (status 'paid') and frees the table.
//
// `type` records which checkout the customer chose so staff know whether to
// bring the ถุงเงิน phone: 'normal' (เงินสด/QR ร้าน) | 'split' (คนละครึ่ง).
export const CHECKOUT_TYPE_LABELS = {
  normal: 'เช็กบิลปกติ',
  split: 'เช็กบิลไทยช่วยไทย',
};

// The actual money the shop received, chosen by staff at settle time. This is
// what the owner's reports split the takings by.
export const PAY_METHOD_LABELS = {
  cash: 'เงินสด',
  qr: 'สแกน QR',
  split: 'ไทยช่วยไทย',
};

// The current checkout stage of a bill, or null when it is still open.
export function checkoutStage(order) {
  return order?.checkout?.stage || null;
}

// A bill is "in checkout" (customer ordering must be locked) once เช็กบิล has
// been requested or the receipt has been printed — but not once it is paid.
export function isCheckoutLocked(order) {
  const s = checkoutStage(order);
  return s === 'requested' || s === 'printed';
}

// ---------------------------------------------------------------------------
// ส่วนลด — a discount as the last line of the bill
// ---------------------------------------------------------------------------
// A discount is not a separate field on the order; it is a LINE, with a negative
// price, sitting at the end of the items. That choice carries its weight:
// everything that already sums a bill — the board card, the customer's phone,
// the printed slip, the owner's reports — arrives at the discounted number
// without knowing this feature exists.
//
// The line is stamped 'served' so it stays off the kitchen board and never holds
// up เช็กบิล (see unservedItems), carries no stockRef so it touches no stock, and
// records `by` — the staff member whose ไอดี unlocked it — so a discount can
// always be traced to a person.
//
// A bill holds at most ONE discount: applying another replaces it, so the
// discount on screen is always the discount in force.
//
// A discount comes in one of two shapes, the `mode` on the line:
//   'percent' — 10% off, re-struck against the subtotal whenever it changes
//   'baht'    — 45 baht off, flat, no arithmetic for the person at the till
// Lines written before the baht option existed carry no `mode` at all, and every
// one of those was a percentage — which is what discountSpec() reads them as.
export function isDiscountItem(item) {
  return item?.kind === 'discount';
}

// A discount line read back as { mode, value } — the thing that was asked for,
// which is what re-applying it after a bill edit has to repeat.
export function discountSpec(line) {
  if (!line) return null;
  return line.mode === 'baht'
    ? { mode: 'baht', value: Math.abs(Number(line.price) || 0) }
    : { mode: 'percent', value: Number(line.percent) || 0 };
}

// How a discount reads on a slip, a card or a button.
export function discountLabel(spec) {
  if (!spec) return '';
  return spec.mode === 'baht'
    ? `${Math.round(spec.value).toLocaleString()} บาท`
    : `${spec.value}%`;
}

// What a discount applies to: everything on the bill except a discount already
// on it (otherwise a second discount would compound on the first).
export function discountBase(items) {
  return (items || [])
    .filter(it => !isDiscountItem(it))
    .reduce((sum, it) => sum + ((it.price || 0) + (it.addonCost || 0)) * (it.qty || 0), 0);
}

// The baht a discount takes off `items`, rounded to whole baht — a till hands
// over notes and coins, not satang, and a slip reading -฿84.50 is a number
// nobody can actually pay.
//
// Both modes are capped at the bill itself: ฿500 off a ฿300 order takes off
// ฿300, never turns into the shop owing the customer money.
export function discountAmount(items, spec) {
  const base = discountBase(items);
  const value = Math.max(0, Number(spec?.value) || 0);
  if (spec?.mode === 'baht') return Math.min(Math.round(value), base);
  return Math.round(base * Math.min(value, 100) / 100);
}

// Put a discount onto a bill (or replace the one it already has) and re-total
// it. `spec` is { mode, value }; `by` is the name of the person who authorised
// it. Returns the next order object; never mutates `order`.
export function withDiscount(order, spec, by) {
  const mode = spec?.mode === 'baht' ? 'baht' : 'percent';
  const value = mode === 'baht'
    ? Math.max(0, Number(spec?.value) || 0)
    : Math.max(0, Math.min(100, Number(spec?.value) || 0));
  const kept = (order.items || []).filter(it => !isDiscountItem(it));
  const amount = discountAmount(kept, { mode, value });
  const items = value > 0 && amount > 0
    ? [...kept, {
        // A baht line is named with the amount actually taken off, not the
        // amount typed — those differ when the cap above bites.
        name: `ส่วนลด ${mode === 'baht' ? `${amount.toLocaleString()} บาท` : `${value}%`}`,
        nameEn: `Discount ${mode === 'baht' ? `฿${amount}` : `${value}%`}`,
        kind: 'discount',
        mode,
        // Still written for a percentage discount, so everything that already
        // reads `percent` keeps working. A baht discount has no percentage.
        percent: mode === 'percent' ? value : 0,
        qty: 1,
        price: -amount,
        addonCost: 0,
        // Off the kitchen board and past the serving gate from the moment it
        // exists — a discount is not something anybody cooks or carries out.
        status: 'served',
        // Rides with the bill's current last round so it never draws a stray
        // "สั่งเพิ่ม รอบที่ N" divider above itself.
        round: (kept || []).reduce((m, it) => Math.max(m, itemRound(it)), 1),
        by: by || '',
        at: Date.now(),
        uid: 'disc' + Date.now().toString(36),
      }]
    : kept;

  return {
    ...order,
    items,
    total: items.reduce((sum, it) => sum + ((it.price || 0) + (it.addonCost || 0)) * (it.qty || 0), 0),
    status: deriveBillStatus(items),
  };
}

// The discount currently on a bill, or null.
export function billDiscount(order) {
  return (order?.items || []).find(isDiscountItem) || null;
}

// ---------------------------------------------------------------------------
// Per-item lifecycle (5 states)
// ---------------------------------------------------------------------------
// Every dish on a bill moves through the kitchen on its own:
//   'received'    รับออเดอร์  — just landed (drinks live here until served)
//   'in_kitchen'  อยู่ในครัว  — on the kitchen board, waiting to be batched/cooked
//   'in_progress' กำลังทำ     — the cook has started it (batch is locked)
//   'completed'   เสร็จแล้ว   — cooked & done; leaves the kitchen board here
//   'served'      เสิร์ฟแล้ว  — delivered to the table (tracked on the order board)
// เช็กบิล (paid) stays a whole-bill state, set when the table checks out.
//
// Food skips 'received': it is auto-placed on the kitchen board ('in_kitchen')
// the moment the order is sent. Drinks never reach the kitchen, so they sit at
// 'received' until staff mark them 'served' from the order-taking tab.
export const ITEM_STATUSES = ['received', 'in_kitchen', 'in_progress', 'completed', 'served'];

// Kept for backwards-compatible imports; the order-taking tab now builds a
// context-specific flow via statusFlowFor().
export const ITEM_STATUS_FLOW = ITEM_STATUSES;

// The statuses that put a dish on the kitchen board. A dish drops off the board
// the moment it is marked 'completed' (เสร็จแล้ว) — delivery/serving is then
// tracked on the order board, not here.
export const KITCHEN_STATUSES = ['in_kitchen', 'in_progress'];

export const ITEM_STATUS_LABELS = {
  received: 'รับออเดอร์',
  in_kitchen: 'อยู่ในครัว',
  in_progress: 'กำลังทำ',
  completed: 'เสร็จแล้ว',
  served: 'เสิร์ฟแล้ว',
};

export const ITEM_STATUS_COLORS = {
  received: 'bg-[#FDECC8] text-[#8a5a00]',
  in_kitchen: 'bg-[#DCE9F7] text-[#2F5D8A]',
  in_progress: 'bg-[#E6DAF7] text-[#5B3A9A]',
  completed: 'bg-[#DCEFE0] text-[#2C6E49]',
  // Light brown, NOT another green: 'completed' (เสร็จแล้ว, off the kitchen board)
  // and 'served' (เสิร์ฟแล้ว, on the table) are two different things, and the two
  // near-identical greens they used to share made the board unreadable at a glance.
  served: 'bg-[#EADBC8] text-[#6B4A2B]',
};

// Is this order line a drink? Drinks are filtered off the kitchen board and
// have a shorter lifecycle. Uses the `group` stamped at order time; older items
// without it read as food (the safe default — food never gets wrongly hidden).
export function isDrinkItem(item) {
  return item?.group === 'drink';
}

// Section headings (the menu's หัวข้อ, exposed as `category`) whose items are
// handed to the table as-is and never cooked — cold towels, desserts, pre-packed
// snacks. Like drinks they skip the kitchen board and take the shorter
// received -> served lifecycle. kitchen.js imports this same set from here.
export const NON_KITCHEN_HEADINGS = new Set(['ผ้าเย็น', 'ของหวาน', 'ขนมหวาน', 'ขนมขบเคี้ยว']);

// A line served straight to the table rather than cooked: every drink, plus the
// non-kitchen headings above. These get the 2-state (received -> served) flow
// and stay off the kitchen board. Reads the `category` stamped on the line at
// order time; a legacy line without it falls back to the drink test alone.
export function isServeDirectItem(item) {
  return isDrinkItem(item) || NON_KITCHEN_HEADINGS.has(item?.category);
}

// Normalise any stored status onto the 5-state vocabulary, healing legacy rows
// written before this feature ('new'/'cooking'). A legacy 'new' serve-direct
// line becomes 'received'; a legacy 'new' cooked dish becomes 'in_kitchen'.
export function normalizeItemStatus(item) {
  const s = item?.status;
  if (!s || s === 'new') return isServeDirectItem(item) ? 'received' : 'in_kitchen';
  if (s === 'cooking') return 'in_progress';
  return ITEM_STATUSES.includes(s) ? s : 'in_kitchen';
}

// Public alias — components read the normalised status through this name.
export function itemStatus(item) {
  return normalizeItemStatus(item);
}

// The statuses a staff member can step a single line through on the order-taking
// tab. Drinks only ever go received -> served; food carries the full kitchen
// chain so staff can still override the cook's board manually.
export function statusFlowFor(item) {
  return isServeDirectItem(item) ? ['received', 'served'] : ITEM_STATUSES.filter(s => s !== 'received');
}

// Roll the per-item statuses up into the ONE bill-level status the boards,
// new-order chime and reports already key on ('new'/'cooking'/'served').
// 'paid'/'cancelled' are terminal whole-bill states owned elsewhere.
//   - all lines served                         -> 'served'
//   - any line not yet started (received /
//     in_kitchen)                              -> 'new'  (keeps the chime + board)
//   - otherwise (cook has started something)    -> 'cooking'
// Mapping in_kitchen -> 'new' is deliberate: a freshly auto-placed food order
// must still trigger the "ออเดอร์ใหม่" chime, which fires only on bill 'new'.
export function deriveBillStatus(items) {
  const list = items || [];
  if (list.length === 0) return 'new';
  const states = list.map(normalizeItemStatus);
  if (states.every(s => s === 'served')) return 'served';
  if (states.some(s => s === 'received' || s === 'in_kitchen')) return 'new';
  return 'cooking';
}

// ---------------------------------------------------------------------------
// The serving gate — เช็กบิลได้เมื่อเสิร์ฟครบทุกจานแล้วเท่านั้น
// ---------------------------------------------------------------------------
// A bill cannot enter checkout (customer เช็กบิล, staff พิมพ์บิล) while any dish
// is still on its way: a slip printed mid-service either charges for food that
// never arrived or misses a dish added while the printer was warming up. Both
// the phone and the staff board ask through here, so the rule is one rule.
//
// Takes a single bill or an array of them (a table can hold several open bills,
// and the customer's เช็กบิล settles all of them at once).
export function unservedItems(bills) {
  return (Array.isArray(bills) ? bills : [bills])
    .flatMap(o => o?.items || [])
    .filter(it => normalizeItemStatus(it) !== 'served');
}

// True once every line on these bills is เสิร์ฟแล้ว — the precondition for
// printing a receipt. Callers pass open bills only; paid/cancelled ones are
// already past this gate.
export function isFullyServed(bills) {
  return unservedItems(bills).length === 0;
}

// The status a line should carry the moment it is sent: cooked food lands
// straight on the kitchen board, serve-direct lines (drinks, cold towels,
// desserts, snacks) wait at received.
export function initialItemStatus(item) {
  return isServeDirectItem(item) ? 'received' : 'in_kitchen';
}

// Stamp the fields the kitchen board needs onto a freshly-added line: a stable
// `uid` (batch actions reference lines across bills) and its initial status.
// Idempotent — an item that already has a uid/status keeps them.
export function stampKitchenFields(item) {
  return {
    ...item,
    uid: item.uid || ('i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
    status: item.status && item.status !== 'new' ? item.status : initialItemStatus(item),
  };
}

// Return a copy of `order` with one item's status changed and the bill-level
// status re-derived to match. Callers guard against paid/cancelled bills.
export function withItemStatus(order, itemIndex, status) {
  const items = order.items.map((it, i) => (i === itemIndex ? { ...it, status } : it));
  return { ...order, items, status: deriveBillStatus(items) };
}

// Highest round currently on a bill.
function maxRound(items) {
  return (items || []).reduce((m, it) => Math.max(m, itemRound(it)), 1);
}

// ---------------------------------------------------------------------------
// รวมจำนวนอาหารชนิดเดียวกัน — folding identical lines together
// ---------------------------------------------------------------------------
// Two order lines are "the same dish" when they are the same menu line (the
// name already carries the เนื้อสัตว์ variant, e.g. "ข้าวกระเพรา (หมูสับ)"),
// same base price, same add-ons and same add-on cost — AND neither carries a
// note. A note makes a line one-of-a-kind (แยกจาน "ไม่เผ็ด"/"ไม่ใส่ผัก"), so a
// noted line never folds into another; nor does a discount line.
export function isMergeableLine(item) {
  return !isDiscountItem(item) && !(item?.note && String(item.note).trim());
}

// A stable identity string for a mergeable line: same string ⇔ same dish.
function lineIdentity(it) {
  const addOns = [...(it.addOns || [])].map(String).sort().join('\u0001');
  return [
    it.name || '',
    it.price || 0,
    it.addonCost || 0,
    it.category || '',
    it.group || '',
    addOns,
  ].join('\u0000');
}

// Fold same-dish lines into one, summing their quantities. Lines that carry a
// note (or a discount) are passed through untouched — each keeps its own row.
// Order is preserved: a folded line sits where its first copy appeared, and
// that first copy's other fields (uid, status, round, roundAt, stockRef, …) are
// the ones kept. The bill total is unchanged by folding (qty × price is the
// same however the copies are grouped).
export function combineLines(items) {
  const out = [];
  const indexByKey = new Map();
  for (const it of items || []) {
    if (!isMergeableLine(it)) { out.push(it); continue; }
    const key = lineIdentity(it);
    const at = indexByKey.get(key);
    if (at === undefined) {
      indexByKey.set(key, out.length);
      out.push({ ...it });
    } else {
      out[at] = { ...out[at], qty: (out[at].qty || 0) + (it.qty || 0) };
    }
  }
  return out;
}

// Fold the whole bill `sourceId` into the bill `destId` and drop the source.
// Used by ย้ายโต๊ะ when two groups push their tables together and ask to pay as
// one — โต๊ะ 1 และ 2 ย้ายมารวมที่โต๊ะ 8.
//
// The destination bill is the one that survives, keeping its id and its เลขที่
// bill number, so anything already printed or referenced still points at it.
// Returns the next `orders` array (never mutates `prev`).
export function absorbBill(prev, sourceId, destId) {
  const source = (prev || []).find(o => o.id === sourceId);
  const dest = (prev || []).find(o => o.id === destId);
  if (!source || !dest || source.id === dest.id) return prev;

  // The incoming rounds continue after the destination's, rather than restarting
  // at 1 — otherwise the ticket would show two "รอบ 1" blocks and the kitchen
  // divider would stop meaning "ordered later".
  const offset = maxRound(dest.items);
  const moved = (source.items || []).map(it => ({ ...it, round: itemRound(it) + offset }));
  const items = [...(dest.items || []), ...moved];

  // The merged bill STARTED when the earlier of the two groups sat down, and was
  // last added to whenever the later of the two last ordered.
  const startedAt = Math.min(dest.createdAt ?? Infinity, source.createdAt ?? Infinity);
  const latest = (source.createdAt || 0) > (dest.createdAt || 0) ? source : dest;

  const merged = {
    ...dest,
    items,
    total: (dest.total || 0) + (source.total || 0),
    status: deriveBillStatus(items),
    createdAt: Number.isFinite(startedAt) ? startedAt : dest.createdAt,
    time: latest.time || dest.time,
    note: [dest.note, source.note].filter(Boolean).join(' | '),
    // If either side had already asked to เช็กบิล, the merged bill stays in that
    // state — the request does not quietly disappear because tables were joined.
    checkout: dest.checkout || source.checkout,
    movedFrom: [...(dest.movedFrom || []), ...(source.movedFrom || []), String(source.table)],
    // The ids this bill has swallowed. A diner's phone follows its own bill by
    // id, so without this trail the absorbed group's screen would lose track of
    // its order the moment the two bills became one (see App.jsx).
    absorbedIds: [...(dest.absorbedIds || []), ...(source.absorbedIds || []), source.id],
    mergedAt: Date.now(),
  };

  // Both halves may have carried a ส่วนลด. The bill that survives keeps ITS
  // terms, re-struck over the joined subtotal — one bill can only have one
  // discount, and the surviving bill's is the one already printed against the
  // number the group is being asked to pay.
  const discount = billDiscount(dest) || billDiscount(source);
  const settled = discount ? withDiscount(merged, discount.percent, discount.by) : merged;

  return prev.filter(o => o.id !== sourceId).map(o => (o.id === destId ? settled : o));
}

// Fold `newOrder` into the table's existing open bill as the next round, or —
// if the table has no open bill — add it as a fresh bill whose items are round
// 1. Returns the next `orders` array (never mutates `prev`).
export function mergeOrder(prev, newOrder) {
  // Grab / กลับบ้าน never merge: each order is its own numbered bill. This runs
  // before the lookup below, so an open Grab#1 is not a merge target at all.
  const channel = singleRoundBase(newOrder.table);
  // A takeaway phone that already has an open bill orders onto it (see
  // takeawayBillIndex) — the only way a channel bill takes a second round
  // without the แก้ไขบิล editor.
  const sessionIdx = channel ? takeawayBillIndex(prev, newOrder.takeawaySession) : -1;
  if (channel && sessionIdx === -1) {
    // Same dish ordered twice in this round folds into one line (qty summed) —
    // unless it carries a note. See combineLines.
    const items = combineLines(newOrder.items.map(it => stampKitchenFields({
      ...it,
      round: 1,
      roundAt: newOrder.createdAt,
    })));
    return [...prev, {
      ...newOrder,
      // The caller may have picked the number already (the staff take-order
      // screen does, so its confirmation can name the bill). Only number an
      // order that arrived as a bare 'Grab' / 'กลับบ้าน'.
      table: isNumberedChannel(newOrder.table)
        ? newOrder.table
        : nextSingleRoundTable(prev, channel, newOrder),
      items,
      status: deriveBillStatus(items),
    }];
  }

  // The table's open bill, whichever shift opened it — see the note at the top
  // of this file for why the shift is deliberately not part of this test.
  const idx = channel ? sessionIdx : prev.findIndex(o =>
    String(o.table) === String(newOrder.table) &&
    o.status !== 'paid' &&
    o.status !== 'cancelled'
  );

  // No open bill yet: this order opens the bill as round 1. Food lands on the
  // kitchen board straight away ('in_kitchen'); drinks wait at 'received'.
  if (idx === -1) {
    // Same dish ordered twice in this round folds into one line (see
    // combineLines); a noted line stays on its own.
    const items = combineLines(newOrder.items.map(it => stampKitchenFields({
      ...it,
      round: 1,
      roundAt: newOrder.createdAt,
    })));
    return [...prev, { ...newOrder, items, status: deriveBillStatus(items) }];
  }

  // Merge into the open bill as the next round.
  const existing = prev[idx];
  const nextRound = maxRound(existing.items) + 1;
  // Fold same-dish lines WITHIN this new round together (qty summed); earlier
  // rounds are left untouched, so the board still shows รอบที่ 1 / รอบที่ 2
  // as separate blocks. Cross-round folding happens only on the printed bill.
  const addedItems = combineLines(newOrder.items.map(it => stampKitchenFields({
    ...it,
    round: nextRound,
    roundAt: newOrder.createdAt,
  })));
  const mergedItems = [...existing.items, ...addedItems];
  // A discount already on this bill has to be re-struck against the new
  // subtotal, or a line reading "ส่วนลด 10%" would quietly stop being 10% the
  // moment the table ordered again — and it would no longer be the last line of
  // the bill either. The percentage and who authorised it are kept; only the
  // baht it comes to is recomputed. See withDiscount.
  const discount = billDiscount(existing);
  const merged = {
    ...existing,
    items: mergedItems,
    total: (existing.total || 0) + (newOrder.total || 0),
    // New food went to the kitchen — the freshly added 'new' dishes pull the
    // derived bill status back to 'new', reopening it so staff are alerted even
    // if the earlier rounds were already served.
    status: deriveBillStatus(mergedItems),
    // Keep the original createdAt (the bill's start); refresh the "last ordered"
    // time so the ticket footer shows the most recent round.
    time: newOrder.time,
    note: [existing.note, newOrder.note].filter(Boolean).join(' | '),
  };
  const next = [...prev];
  next[idx] = discount ? withDiscount(merged, discount.percent, discount.by) : merged;
  return next;
}
