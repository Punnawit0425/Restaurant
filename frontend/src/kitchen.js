// ---------------------------------------------------------------------------
// Kitchen batch engine (pure)
// ---------------------------------------------------------------------------
// Turns the shared `orders` state into the grouped cards the kitchen board
// renders. Everything here is a side-effect-free derivation recomputed on every
// render, so batching stays perfectly in step with the live orders arriving over
// SSE — there is no batch state to keep in sync.
//
// What IS persisted (on the order items themselves, by KitchenBoard) is only the
// two things a pure derivation cannot infer: the per-line `status` and, once a
// cook presses "กำลังทำ", a shared `batchId` that freezes that group through
// cooking. Before that lock, batching is entirely derived from the rules below.
//
// The batching rules (from the spec):
//   * A "queue" = one ticket = one ordering round that reached the kitchen,
//     numbered 1..N by arrival time across every open bill.
//   * Two lines batch together only if: same dish name (protein is folded into
//     the name, so it is matched too) AND neither carries a free-text note.
//     Add-ons like ไข่ดาว do NOT break a batch.
//   * Sliding window: a batch anchored at queue Q may absorb matching lines from
//     queues Q..Q+BATCH_WINDOW only. A later queue starts a fresh batch.
//   * A line already locked (in_progress/completed, i.e. it has a batchId) is
//     never re-batched — it groups strictly by its batchId.
// ---------------------------------------------------------------------------

import { normalizeItemStatus, KITCHEN_STATUSES, NON_KITCHEN_HEADINGS } from './orders';
import { orderShift } from './shift';

// A batch anchored at queue Q reaches up to Q + BATCH_WINDOW (so 3 consecutive
// queues: the anchor plus two more).
export const BATCH_WINDOW = 2;

const CLOSED = new Set(['paid', 'cancelled']);

// Menu names can fold in a protein — "ข้าวผัด (หมู)". Strip it to match a menu
// row when an item is missing its stamped `group` (legacy orders).
function stripProtein(name) {
  return String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// The dish's section heading (built menu's `category`), looked up by the stamped
// menuId first and then by name, so an order line can be screened even though it
// only carries a name/menuId. Empty string when it can't be resolved.
function resolveHeading(item, menu) {
  if (!menu || !menu.length) return '';
  const m =
    menu.find(mn => mn.id === item?.menuId) ||
    menu.find(mn => mn.name === item?.name || mn.name === stripProtein(item?.name));
  return m?.category || '';
}

// food | drink for one order line. Prefers the `group` stamped at order time;
// falls back to a menu lookup by name so legacy drinks are still kept off the
// board. Unknown -> 'food' (food must never be wrongly hidden).
function resolveGroup(item, menu) {
  if (item?.group) return item.group;
  if (menu && menu.length) {
    const m = menu.find(mn => mn.name === item?.name || mn.name === stripProtein(item?.name));
    if (m?.group) return m.group;
  }
  return 'food';
}

// Flatten every open bill into the food lines currently on the kitchen board,
// each tagged with its queue number. Drinks and served/paid/cancelled lines are
// dropped. `shift` (optional) screens to one day/night board.
export function kitchenItems(orders, { menu, shift } = {}) {
  const refs = [];
  for (const order of orders || []) {
    if (!order || CLOSED.has(order.status)) continue;
    if (shift && orderShift(order) !== shift) continue;
    (order.items || []).forEach((item, itemIndex) => {
      if (resolveGroup(item, menu) === 'drink') return;
      // Cold towels / desserts / snacks are handed over as-is, not cooked.
      if (NON_KITCHEN_HEADINGS.has(resolveHeading(item, menu))) return;
      const status = normalizeItemStatus(item);
      if (!KITCHEN_STATUSES.includes(status)) return;
      refs.push({
        orderId: order.id,
        table: order.table,
        itemIndex,
        uid: item.uid || `${order.id}#${itemIndex}`,
        name: item.name,
        qty: item.qty || 1,
        addOns: item.addOns || [],
        note: (item.note || '').trim(),
        status,
        batchId: item.batchId || null,
        round: item.round || 1,
        roundAt: item.roundAt || order.createdAt || 0,
      });
    });
  }

  // Number the queues: one queue per ticket (bill + round), ordered by arrival.
  const ticketAt = new Map();
  for (const r of refs) {
    const key = `${r.orderId}#${r.round}`;
    const at = ticketAt.get(key);
    if (at == null || r.roundAt < at) ticketAt.set(key, r.roundAt);
  }
  const order = [...ticketAt.entries()].sort((a, b) => a[1] - b[1]);
  const queueNo = new Map(order.map(([key], i) => [key, i + 1]));
  for (const r of refs) r.queueNo = queueNo.get(`${r.orderId}#${r.round}`);
  return refs;
}

// Finalise a batch's derived fields from its member lines.
function finalize(batch) {
  const members = batch.members;
  const queues = [...new Set(members.map(m => m.queueNo))].sort((a, b) => a - b);
  const tables = [...new Set(members.map(m => m.table))];
  const statuses = members.map(m => m.status);
  // A group's status: all members move together, but if they ever disagree,
  // report the least-finished so the right action button shows.
  const status = statuses.includes('in_kitchen')
    ? 'in_kitchen'
    : statuses.includes('in_progress') ? 'in_progress' : 'completed';
  return {
    ...batch,
    members,
    anchorQueue: Math.min(...members.map(m => m.queueNo)),
    totalQty: members.reduce((s, m) => s + m.qty, 0),
    queues,
    tables,
    status,
    isBatch: members.length > 1,
  };
}

// Group the flattened lines into batch cards.
export function buildBatches(items) {
  const batches = [];

  // Locked lines (already have a batchId) group strictly by that id — the cook
  // committed to this grouping, so nothing new joins and nothing re-splits here.
  const locked = new Map();
  const unlocked = [];
  for (const it of items) {
    if (it.batchId) {
      if (!locked.has(it.batchId)) locked.set(it.batchId, []);
      locked.get(it.batchId).push(it);
    } else {
      unlocked.push(it);
    }
  }
  for (const [batchId, members] of locked) {
    batches.push(finalize({ id: batchId, locked: true, name: members[0].name, members }));
  }

  // Unlocked lines auto-batch by name within the sliding window. Walk them in
  // queue order so the earliest occurrence of a dish anchors its batch.
  unlocked.sort((a, b) => (a.queueNo - b.queueNo) || (a.roundAt - b.roundAt));
  const openByKey = new Map(); // dish name -> the batch currently accepting joins
  for (const it of unlocked) {
    // Only lines still waiting ('in_kitchen') auto-batch. A noted line, or one a
    // staff member manually advanced without going through the board (so it has
    // a cooking status but no batchId), is always its own card.
    if (it.note || it.status !== 'in_kitchen') {
      batches.push(finalize({ id: `solo-${it.uid}`, locked: false, name: it.name, members: [it] }));
      continue;
    }
    const open = openByKey.get(it.name);
    if (open && it.queueNo <= open.anchorQueue + BATCH_WINDOW) {
      open.members.push(it);
    } else {
      const b = { id: `auto-${it.name}-${it.queueNo}`, locked: false, name: it.name, members: [it], anchorQueue: it.queueNo };
      openByKey.set(it.name, b);
      batches.push(b);
    }
  }

  return batches.map(b => (b.queues ? b : finalize(b)));
}

// Domino ordering (spec 4): earliest anchor queue first, and within a ticket the
// solo dishes come before the shared batch — so a batch card sits as the anchor
// table's last item while simultaneously heading the next table's queue.
export function sortBatches(batches) {
  return [...batches].sort((a, b) =>
    (a.anchorQueue - b.anchorQueue) ||
    ((a.isBatch ? 1 : 0) - (b.isBatch ? 1 : 0)) ||
    (Math.min(...a.members.map(m => m.roundAt)) - Math.min(...b.members.map(m => m.roundAt)))
  );
}

// One call the board uses: orders -> ordered batch cards.
export function kitchenBoard(orders, opts) {
  return sortBatches(buildBatches(kitchenItems(orders, opts)));
}
