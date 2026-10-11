// ---------------------------------------------------------------------------
// What a diner's phone is allowed to put on a bill
// ---------------------------------------------------------------------------
// A customer tab has no session, so everything it sends is a claim, not a fact.
// The ordering screen builds each line with its own price, add-on cost and
// status, and the bill with its own total — all of it editable by anyone who
// opens the browser's dev tools or calls the API directly. Taken as-is, that
// let a stranger with the public URL:
//
//   * order ผัดกะเพรา at 1 baht (the line's `price` was whatever was sent);
//   * file a bill already marked `paid` with any total, straight into the
//     owner's sales figures;
//   * attach `absorbedIds` naming other bills, which every later write — and
//     every restart — then treats as รวมบิล and drops, paid history included.
//
// So a session-less write never contributes fields, only an ORDER: which dish,
// which option, which extras, how many, and a note. Everything that carries
// money or authority is rebuilt here from the server's own menu and presets.
// Signed-in staff writes do not come through this file — voiding, discounting,
// settling and merging bills are their job.
// ---------------------------------------------------------------------------

import { buildPresetsFromLegacy } from './addon-presets.js';

// A rejected order. `message` is shown to the diner as-is.
export class OrderRejected extends Error {}

const MAX_LINES = 100;
const MAX_QTY = 999;

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isDiscountItem = (it) => it?.kind === 'discount';

// The extras one dish offers, as { groups, addons }:
//   groups — pick-exactly-one sets (ขนาด, ระดับความหวาน): each contributes one option
//   addons — tick boxes (ไข่ดาว, ไข่มุก): each may be picked once
// Same rule as extrasFor in frontend/src/menu-groups.js. An install that has
// not migrated to presets yet is priced from the presets the migration would
// generate, which is exactly what its order screen is offering.
function extrasOfDish(dish, ctx) {
  const presets = Array.isArray(ctx.addonPresets)
    ? ctx.addonPresets
    : buildPresetsFromLegacy(ctx.menu, ctx.addons, ctx.choices);
  const linked = presets.filter((p) => Array.isArray(p?.menuIds) && p.menuIds.includes(dish.id));
  const option = (o) => ({ name: String(o?.name ?? ''), price: Number(o?.price) || 0 });
  return {
    groups: linked
      .filter((p) => p.mode === 'single' && (p.options || []).length > 0)
      .map((p) => p.options.map(option)),
    addons: linked.filter((p) => p.mode !== 'single').flatMap((p) => (p.options || []).map(option)),
  };
}

// Price the add-on names on one line against what the dish actually offers.
// Each pick-one group can be used once and each tick box once, so a name cannot
// be counted twice to inflate — or a group skipped to deflate — the line.
function addonCostOf(dish, names, ctx) {
  const { groups, addons } = extrasOfDish(dish, ctx);
  const groupsLeft = [...groups];
  const addonsLeft = [...addons];
  let cost = 0;
  for (const raw of names) {
    const name = String(raw ?? '');
    const g = groupsLeft.findIndex((opts) => opts.some((o) => o.name === name));
    if (g !== -1) {
      cost += groupsLeft[g].find((o) => o.name === name).price;
      groupsLeft.splice(g, 1);
      continue;
    }
    const a = addonsLeft.findIndex((o) => o.name === name);
    if (a !== -1) {
      cost += addonsLeft[a].price;
      addonsLeft.splice(a, 1);
      continue;
    }
    throw new OrderRejected(`ตัวเลือก "${name}" ของ ${dish.name} มีการเปลี่ยนแปลง กรุณาเลือกใหม่อีกครั้ง`);
  }
  return cost;
}

// One line a diner is adding, rebuilt from the menu. The name has to be the
// dish's own (with its option folded in, as the order screen writes it), so a
// line cannot point at a cheap dish while showing the kitchen something else.
export function cleanCustomerLine(line, ctx) {
  const dish = (ctx.menu || []).find((m) => m.id === line?.menuId);
  if (!dish) throw new OrderRejected('มีเมนูในตะกร้าที่ไม่มีในร้านแล้ว กรุณาลบออกแล้วสั่งใหม่');

  const name = String(line.name ?? '');
  const options = Array.isArray(dish.options) ? dish.options : [];
  let price;
  if (options.length) {
    const opt = options.find((o) => name === `${dish.name} (${o.name})`);
    if (opt) price = Number(opt.price) || 0;
  } else if (name === dish.name) {
    price = Number(dish.price) || 0;
  }
  if (price === undefined) throw new OrderRejected(`ไม่พบ "${name}" ในเมนู กรุณาลบออกแล้วสั่งใหม่`);

  const qty = Number(line.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new OrderRejected('จำนวนไม่ถูกต้อง');

  const addOns = Array.isArray(line.addOns) ? line.addOns.map((a) => String(a ?? '')) : [];
  // Only the two statuses a fresh line starts in (see initialItemStatus); a
  // diner cannot hand the kitchen a dish that is already cooked or served.
  const status = line.status === 'received' ? 'received' : 'in_kitchen';

  return {
    uid: typeof line.uid === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(line.uid)
      ? line.uid
      : 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name,
    nameEn: text(line.nameEn, 300),
    menuId: dish.id,
    group: dish.group || 'food',
    category: dish.category,
    qty,
    price,
    addonCost: addonCostOf(dish, addOns, ctx),
    addOns,
    addOnsEn: Array.isArray(line.addOnsEn) ? line.addOnsEn.map((a) => text(a, 200)) : [],
    note: text(line.note, 500),
    stockRef: dish.stockRef || null,
    status,
    round: Number.isInteger(line.round) && line.round > 0 ? line.round : 1,
    roundAt: Number.isFinite(line.roundAt) ? line.roundAt : Date.now(),
  };
}

// The เช็กบิล request a diner may stamp on an open bill — and nothing else that
// could ride along inside it.
export function cleanCheckoutRequest(checkout) {
  if (checkout?.stage !== 'requested') return null;
  return {
    stage: 'requested',
    type: text(checkout.type, 40),
    requestedAt: Number.isFinite(checkout.requestedAt) ? checkout.requestedAt : Date.now(),
  };
}

// A brand-new bill from a diner, rebuilt from the fields the order screen sends
// (see handlePlaceOrder in CustomerView). Status and total are derived here;
// paid/cancelled, discounts, รวมบิล trails and payment details cannot arrive
// this way at all.
export function cleanCustomerOrder(order, ctx, deriveBillStatus) {
  const lines = (Array.isArray(order.items) ? order.items : []).filter((it) => !isDiscountItem(it));
  if (!lines.length) throw new OrderRejected('ไม่มีรายการอาหารในออเดอร์');
  if (lines.length > MAX_LINES) throw new OrderRejected('รายการในออเดอร์มากเกินไป');
  const items = lines.map((it) => cleanCustomerLine(it, ctx));

  if (typeof order.id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(order.id)) {
    throw new OrderRejected('รหัสออเดอร์ไม่ถูกต้อง');
  }

  return {
    id: order.id,
    ...(typeof order.no === 'string' ? { no: order.no.slice(0, 40) } : {}),
    time: text(order.time, 20),
    createdAt: Number.isFinite(order.createdAt) ? order.createdAt : Date.now(),
    type: order.type === 'night' ? 'night' : 'day',
    table: text(String(order.table ?? ''), 40),
    ...(order.takeawaySession ? { takeawaySession: order.takeawaySession } : {}),
    items,
    total: items.reduce((sum, it) => sum + (it.price + it.addonCost) * it.qty, 0),
    status: deriveBillStatus(items),
    note: text(order.note, 1000),
    by: 'ลูกค้าสแกน',
  };
}
