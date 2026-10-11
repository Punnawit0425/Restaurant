import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { extrasFor, defaultChoices, choicesCost } from '../menu-groups';
import { searchMenu, SHIFT_LABELS, GROUP_LABELS } from '../menu-search';
import { shiftNow, workdayKey } from '../shift';
import { generateInvoiceNo, generateOrderNo } from '../invoice';
import { mergeOrder, absorbBill, combineLines, itemRound, itemStatus, statusFlowFor, deriveBillStatus, ITEM_STATUS_LABELS, ITEM_STATUS_COLORS, stampKitchenFields, checkoutStage, unservedItems, CHECKOUT_TYPE_LABELS, PAY_METHOD_LABELS, GRAB_TABLE, TAKEAWAY_TABLE, singleRoundBase, nextSingleRoundTable, tableLabel, isDiscountItem, billDiscount, discountBase, discountAmount, discountSpec, discountLabel, withDiscount } from '../orders';
import KitchenBoard from './KitchenBoard';
import PinGate from './PinGate';
import { fetchStockItems, adjustStockItem, consumeStockByName, resolveImageUrl } from '../api';
import { newStockOpKey, queueStockCut, flushStockCuts, pendingStockCutCount, isPermanentStockError } from '../stock-retry';
import { STOCK_ACTION_LABELS, STOCK_ACTION_COLORS, STOCK_HISTORY_DAY_LIMIT, fmtStockTime, useStockHistory } from '../stock-history';
import StockHistoryDateBar from './StockHistoryDateBar';
import generatePayload from 'promptpay-qr';
import { QRCodeSVG } from 'qrcode.react';
import {
  ClipboardList,
  Package,
  Plus,
  Minus,
  Trash2,
  PlusCircle,
  AlertTriangle,
  Check,
  Edit,
  X,
  Clock,
  MapPin,
  ChefHat,
  Printer,
  RotateCcw,
  Bell,
  Search,
  TicketPercent
} from 'lucide-react';

// Money on the printed slip: always two decimals with a thousands separator
// (e.g. 1,340.00), matching a standard thermal receipt.
const fmtBaht = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Chime patterns as [frequency, seconds from now] pairs. A new order is a
// two-note "ding-dong"; a table asking to pay is a rising triple rung twice, so
// it is unmistakably a different event and carries from across the shop.
const NEW_ORDER_CHIME = [[880, 0], [1174, 0.14]];
const CHECKOUT_CHIME = [
  [1046, 0], [1318, 0.12], [1568, 0.24],
  [1046, 0.5], [1318, 0.62], [1568, 0.74],
];

// A dish finds its คลังวัตถุดิบ row by name under LOWER(TRIM(...)) on the
// server (see consumeStockByName). The checks here must use the same rule: a
// plain `===` missed a row imported with a stray space or different case, so
// the "สินค้าหมดแล้ว" guard let a dish through that the server then cut anyway.
const stockKey = (v) => String(v || '').trim().toLowerCase();

function StaffView({
  theme,
  menu, 
  orders, 
  setOrders, 
  stock, 
  setStock, 
  settings, 
  activeStaffUser, 
  showToast,
  addons,
  choices,
  addonPresets
}) {
  const [subTab, setSubTab] = useState('orders'); // orders, take-order, kitchen, stock
  // คลังวัตถุดิบ tab: read from the SQL `stock_items` table (not the mockup
  // drink `stock` used when taking an order). Loaded when the tab is opened.
  const [stockItems, setStockItems] = useState([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState('');
  const [stockSearch, setStockSearch] = useState('');
  // Stock cuts that failed to reach the server and are waiting to be resent
  // (see stock-retry.js). Shown as a banner until the queue is empty.
  const [pendingCuts, setPendingCuts] = useState(pendingStockCutCount);
  // ประวัติการบันทึกสต็อก: the audit-log panel, opened from a button in the
  // คลังวัตถุดิบ tab. Loaded on demand so a closed panel costs nothing.
  const [showStockHistory, setShowStockHistory] = useState(false);
  const {
    items: stockHistory, loading: historyLoading, error: historyError,
    date: historyDate, setDate: setHistoryDate, reload: reloadStockHistory,
  } = useStockHistory();
  const [orderFilter, setOrderFilter] = useState('active'); // active, new, cooking, served, paid, all
  // The bill currently being sent to the printer. It is rendered into a hidden
  // #bill-print slip (80mm, styled for the Xprinter XP-80T) and fired straight
  // at window.print() — no on-screen preview. Cleared once printing returns.
  // { table, billIds, total, items, type } | null
  const [printData, setPrintData] = useState(null);
  // An action waiting for someone to identify themselves with their ไอดีพนักงาน:
  // { title, detail, confirmLabel, run(person) }. Printing a bill and giving a
  // discount both go through this, so the name that ends up on the slip is the
  // name of whoever actually stood at the till — not just whoever is signed in
  // on this tablet. Cleared on cancel and after `run` has fired.
  const [pinAction, setPinAction] = useState(null);
  // The bill a discount is being set on, and the percentage typed for it. Held
  // as the order id (not the object) so the preview always reads the live bill —
  // a round arriving while the box is open must change what the % is worth.
  const [discountFor, setDiscountFor] = useState(null);
  // The ส่วนลด box: which kind of discount is being typed, and the number.
  // 'percent' is the default because it is the one that was there first and the
  // one most promotions are written in.
  const [discountMode, setDiscountMode] = useState('percent'); // percent | baht
  const [discountValue, setDiscountValue] = useState('');
  // The day/night staff split is gone: one unified board shows and notifies for
  // EVERY order regardless of the shift it was placed in. `theme` still follows
  // the Bangkok clock (App flips it at 06:00 / 17:00) and drives which day/night
  // menu the รับออเดอร์ tab shows and stamps onto new orders — the menu stays
  // split by time — but it no longer screens the board.

  // Direct ordering states
  const [targetTable, setTargetTable] = useState('1');
  const [takeOrderCart, setTakeOrderCart] = useState([]);
  // null = ทุกหมวดหมู่. Browsing must never start on a hidden subset: with no
  // category picked the list shows everything the shift/group chips allow.
  const [directCat, setDirectCat] = useState(null);
  const [directGroup, setDirectGroup] = useState('all'); // 'all' | 'food' | 'drink'
  // ค้นหาเมนูในหน้ารับออเดอร์: when non-empty, the item list searches the ENTIRE
  // menu — both shifts, food and drink, every category — ignoring the chips and
  // the category dropdown, so a dish can never hide behind a filter. Empty
  // falls back to browsing whatever the chips + category select.
  const [directSearch, setDirectSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null); // chosen protein/size (เนื้อสัตว์)
  const [modalQty, setModalQty] = useState(1);
  const [modalNotes, setModalNotes] = useState('');
  const [selectedAddons, setSelectedAddons] = useState([]);
  // Pick-exactly-one groups (ขนาด / ระดับความหวาน), keyed by group name.
  const [selectedChoices, setSelectedChoices] = useState({});
  const [detailMode, setDetailMode] = useState('cart'); // 'cart' (take-order) | 'editbill'

  // Custom "เมนูอื่นๆ" — a staff-typed item that isn't on the menu (never
  // touches stock). Extras are toggle chips with editable prices; takeaway is a
  // flag surfaced to the kitchen.
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [customQty, setCustomQty] = useState(1);
  const [customNote, setCustomNote] = useState('');
  const [customTakeaway, setCustomTakeaway] = useState(false);
  const [customExtras, setCustomExtras] = useState({
    'ไข่ดาว': { on: false, price: 10 },
    'ไข่เจียว': { on: false, price: 15 },
    'กับข้าว': { on: false, price: 20 }
  });

  // Edit Bill states
  const [editingBill, setEditingBill] = useState(null); // holds the order object being edited
  // Line uids the bill had when the edit modal opened — anything else on the
  // live bill at save time is a round that arrived meanwhile (see handleSaveEditedBill).
  const editBillBaseUids = useRef(new Set());
  const [editAddMenuId, setEditAddMenuId] = useState('');

  // --- New-order notifications (toast + sound) ------------------------------
  // Every order that lands has to reach staff, and "an order" is NOT the same
  // thing as "a bill": a table that orders again is folded into the bill it
  // already has (mergeOrder), so watching bill ids alone would ring for โต๊ะ 5's
  // first order and stay silent for every round after it — food would sit on the
  // board unnoticed. So each bill is remembered by its highest ROUND number, and
  // a round appearing is what rings, whether it opened the bill or not.
  //
  // Two things deliberately do NOT ring:
  //   * items staff add through แก้ไขบิล — those join the bill's current last
  //     round on purpose, so the number does not move (see the editbill branch
  //     of the add-item handler). The person adding them is already looking.
  //   * รวมบิล — absorbing a bill re-numbers the incoming rounds on top of the
  //     destination's, which bumps the count without a single new dish. The
  //     absorbed-id count is tracked alongside the round to tell the two apart.
  //
  // On mount everything already on the board is recorded silently, so opening
  // the panel never replays the day.
  const seenRounds = useRef(null);
  const audioCtxRef = useRef(null);

  // The bill's newest ordering round, and how many bills it has swallowed.
  const orderBeat = (o) => ({
    round: (o.items || []).reduce((m, it) => Math.max(m, itemRound(it)), 1),
    absorbed: (o.absorbedIds || []).length,
  });

  // What the round that just landed is worth — the bill total would announce
  // ฿840 for a ฿90 refill, which is the number staff would then repeat back to
  // the table.
  const roundTotal = (o, round) =>
    (o.items || [])
      .filter(it => itemRound(it) === round)
      .reduce((sum, it) => sum + (it.price + (it.addonCost || 0)) * it.qty, 0);

  // Plays one of the chime patterns via the Web Audio API — no audio file to ship,
  // and a blocked/suspended context can never break the board (best-effort only).
  const playChime = (pattern = NEW_ORDER_CHIME) => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      pattern.forEach(([freq, at]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.3, now + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.25);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.26);
      });
    } catch {
      /* audio is best-effort */
    }
  };

  // A browser keeps an AudioContext suspended until the page has been
  // interacted with, and iOS only lets it be resumed from inside the gesture
  // itself — so a context first created when an order lands can come up mute,
  // and the shop loses the very alert it relies on. The first touch anywhere in
  // the panel opens it instead: from then on every chime can fire on its own.
  useEffect(() => {
    const unlock = () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
        if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
      } catch {
        /* audio is best-effort */
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    const snapshot = new Map(orders.map(o => [o.id, orderBeat(o)]));
    // First run: remember everything already on the board without notifying.
    if (seenRounds.current === null) {
      seenRounds.current = snapshot;
      return;
    }
    const fresh = orders.filter(o => {
      const before = seenRounds.current.get(o.id);
      if (!before) return true;                       // a bill that just opened
      const now = orderBeat(o);
      // A later round on a bill we already know — unless the rounds only moved
      // because another bill was merged into this one.
      return now.round > before.round && now.absorbed === before.absorbed;
    });
    // Record every bill's new beat (even the other shift's) so a later shift
    // toggle doesn't replay orders as if they had only just arrived.
    seenRounds.current = snapshot;
    if (fresh.length === 0) return;
    const matching = fresh.filter(o => o.status === 'new');
    if (matching.length > 0) {
      matching.forEach(o => {
        // Name the round, so staff can tell "โต๊ะ 5 just sat down" from
        // "โต๊ะ 5 has ordered again" without opening the card.
        const round = orderBeat(o).round;
        const what = round > 1 ? `สั่งเพิ่ม รอบที่ ${round}` : 'ออเดอร์ใหม่';
        const amount = round > 1 ? roundTotal(o, round) : (o.total || 0);
        showToast(`🔔 ${what} ${tableLabel(o.table)} · ฿${amount.toLocaleString()}`);
      });
      playChime();
    }
  }, [orders]);

  // --- Check-bill requests (customer tapped เช็กบิล on their phone) -----------
  // The board card for a requesting table already shows an amber banner, but
  // staff are often on another tab (or another table) when it happens, so the
  // request has to come to them: a toast plus its own chime the moment it lands.
  // Only the ids currently requesting are remembered, so a table that cancels and
  // asks again rings a second time.
  const seenCheckoutIds = useRef(null);

  // Every table waiting to be billed — drives both the alert above and the
  // notification below. No longer screened by shift: one board sees them all.
  const checkoutRequests = orders.filter(
    (o) => checkoutStage(o) === 'requested'
  );

  useEffect(() => {
    const requesting = orders.filter(
      (o) => checkoutStage(o) === 'requested'
    );
    const ids = new Set(requesting.map((o) => o.id));
    // First run: whatever is already waiting was requested before this screen
    // opened — show it on the board, but don't ring for it.
    if (seenCheckoutIds.current === null) {
      seenCheckoutIds.current = ids;
      return;
    }
    const fresh = requesting.filter((o) => !seenCheckoutIds.current.has(o.id));
    seenCheckoutIds.current = ids;
    if (fresh.length === 0) return;
    fresh.forEach((o) =>
      showToast(
        `🔔 โต๊ะ ${o.table} ขอเช็กบิล · ${CHECKOUT_TYPE_LABELS[o.checkout?.type] || 'เช็กบิลปกติ'} · ฿${(o.total || 0).toLocaleString()}`
      )
    );
    playChime(CHECKOUT_CHIME);
  }, [orders]);

  // หน้ารับออเดอร์ shows ONE menu: the shift being worked. At 10:00 that is
  // เมนูกลางวัน, at 20:00 เมนูกลางคืน — `theme` follows the Bangkok clock and
  // flips on its own at 06:00 / 17:00 (see App.jsx), so this needs no switch.
  // 'both' items (bottled drinks, snacks) belong to neither menu on their own,
  // so they ride along with whichever shift is open.
  //
  // Both menus were briefly listed side by side here. The owner asked for the
  // split back: the two price lists share dish names at different prices
  // (฿50 ข้าวผัด vs ฿70 ข้าวผัด), and having both on screen meant the wrong one
  // got keyed. One shift on screen = one price.
  const shiftMenu = menu.filter(item => item.theme === theme || item.theme === 'both');

  // The WHOLE menu, both shifts. Only แก้ไขบิล reads this: a table sitting
  // through the 17:00 changeover has to be able to add the dish it ordered an
  // hour ago, which is no longer on the open menu.
  const orderableMenu = menu;

  // Which shift's extras a dish takes. A night ยำ ordered at 14:00 must still
  // offer the NIGHT addons/choices, so this follows the dish, not the clock;
  // 'both' items (bottled drinks, snacks) have no menu of their own and fall
  // back to the shift being worked.
  const themeOf = (item) =>
    item?.theme === 'day' || item?.theme === 'night' ? item.theme : theme;

  // What one dish offers: the owner's ตัวเลือกเสริม presets when they exist,
  // otherwise the shift-derived lists. { addons, choices } either way, so the
  // dialog below renders the same tick boxes and radios it always has.
  const extrasOf = (item) => extrasFor(addonPresets, addons, choices, themeOf(item), item);
  const selectedExtras = selectedItem
    ? extrasOf(selectedItem)
    : { addons: [], choices: [] };

  const inGroup = (item) =>
    directGroup === 'all' || (item.group || 'food') === directGroup;

  // The pool the category dropdown describes, and what browsing lists when no
  // category is picked — this shift's menu, narrowed by the อาหาร/เครื่องดื่ม chip.
  const browsableMenu = shiftMenu.filter(inGroup);
  const categories = [...new Set(browsableMenu.map(item => item.category))];

  // A category that the chips just filtered away would otherwise keep an empty
  // list on screen. Falling back to ทุกหมวดหมู่ (null) always shows something.
  if (directCat && !categories.includes(directCat)) {
    setDirectCat(null);
  }

  // Filter orders for listing
  const getFilteredOrders = () => {
    // One unified board — day and night orders together, screened only by status.
    const list = [...orders];

    if (orderFilter === 'active') {
      // OLDEST bill on top. The table that ordered first is the one to serve
      // first, and it must not slide down the board every time another table
      // orders. `createdAt` is the bill's START — mergeOrder keeps it when a
      // table orders more — so a table holds its place for the whole sitting.
      return list
        .filter(o => o.status !== 'paid' && o.status !== 'cancelled')
        .sort((a, b) => a.createdAt - b.createdAt);
    }

    // The other filters are history, where the most recent is what you want to
    // read first, so those stay newest-first.
    list.sort((a, b) => b.createdAt - a.createdAt);
    if (orderFilter !== 'all') {
      return list.filter(o => o.status === orderFilter);
    }
    return list;
  };

  // Actually settle bills once a payment method is confirmed in the pay modal.
  // On payment: stamp a bill number, mark paid and record the checkout time +
  // method ('cash' | 'qr'). Kept in `orders` as paid history (OwnerView reports
  // read it); the table frees up on its own because every board view ignores paid
  // bills. billIds arrive oldest-first so running invoice numbers stay
  // chronological; numbers are built up on a working copy so bill #2 counts
  // bill #1 and each gets a distinct, sequential number.
  const settleBills = (billIds, table, payMethod) => {
    const paidAt = Date.now();
    setOrders(prev => {
      const working = [...prev];
      for (const id of billIds) {
        const idx = working.findIndex(o => o.id === id);
        if (idx === -1) continue;
        const invoiceNo = working[idx].invoiceNo || generateInvoiceNo(working[idx], working);
        // The bill is settled: stamp it paid + the money actually received, and
        // clear the checkout stage so it reads as a clean paid record.
        working[idx] = { ...working[idx], invoiceNo, status: 'paid', paidAt, payMethod, checkout: null };
      }
      return working;
    });
    // Free the table for the next group: drop any lingering workspace bound to it.
    clearTableWorkspace(table);
    showToast(`เช็คบิล โต๊ะ ${table} เรียบร้อยแล้ว โต๊ะพร้อมรับลูกค้าใหม่`);
  };

  // --- Checkout flow (ใส่ไอดี → พิมพ์บิล → เลือกประเภทเงิน → เคลียร์โต๊ะ) -------
  // Ask who is printing, then print. EVERY press asks — including พิมพ์ซ้ำ —
  // because the point of the code is to record the person who handed this
  // particular slip to the table, and a session that stayed unlocked after the
  // first bill would let the next one be printed under their name by whoever
  // picked the tablet up.
  const requestPrintBill = (order) => {
    if (!order || order.status === 'paid' || order.status === 'cancelled') return;
    // เสิร์ฟครบทุกจานก่อน ถึงพิมพ์บิลได้ — a slip printed while food is still in
    // the kitchen charges for what has not arrived. Checked BEFORE the code is
    // asked for: no point typing four digits into a refusal. Re-printing a bill
    // already at 'printed' is fine — it passed this gate on the first print.
    const remaining = unservedItems(order).length;
    if (checkoutStage(order) !== 'printed' && remaining > 0) {
      showToast(`ยังเสิร์ฟไม่ครบ (เหลือ ${remaining} รายการ) — กด "เสิร์ฟครบทุกจาน" ก่อนพิมพ์บิล`);
      return;
    }
    setPinAction({
      title: 'ใครเป็นคนพิมพ์บิลนี้?',
      detail: `${tableLabel(order.table)} · ยอด ฿${(order.total || 0).toLocaleString()} — ชื่อที่ใส่ไอดีจะถูกพิมพ์ลงบนบิล`,
      confirmLabel: 'พิมพ์บิล',
      run: (person) => printBill(order, person),
    });
  };

  // Print the receipt for one bill. This opens the printable overlay AND moves
  // the bill into the 'printed' stage, which is what makes the money-type
  // buttons appear on the card (they are hidden until the bill is printed).
  //
  // `person` is the account resolved from the ไอดีพนักงาน that was just typed.
  // It is stamped onto the bill as well as onto the slip, so "who printed this"
  // survives on the record and not only on the piece of paper.
  const printBill = (order, person) => {
    if (!order || order.status === 'paid' || order.status === 'cancelled') return;
    const type = order.checkout?.type || 'normal';
    const printedBy = { user: person?.user || activeStaffUser || '', name: person?.name || 'พนักงาน', at: Date.now() };
    // Kept on the ORDER, not inside `checkout` — settling clears the checkout
    // block, and "who printed this bill" has to outlive the sale it belongs to.
    setOrders(prev => prev.map(o =>
      o.id === order.id
        ? { ...o, printedBy, checkout: { ...(o.checkout || {}), stage: 'printed', type } }
        : o
    ));
    // Stash the slip's data; the effect below paints it into #bill-print and
    // fires window.print() straight away, so there is no preview to dismiss.
    setPrintData({
      table: order.table,
      billIds: [order.id],
      total: order.total || 0,
      // On the printed slip the same dish appears ONCE with its total quantity,
      // even when it was ordered across several rounds — the board keeps the
      // rounds separate, the bill does not. Noted lines stay on their own row.
      // Folding never changes the total. See combineLines.
      items: combineLines(order.items),
      type,
      printedAt: printedBy.at,
      staff: printedBy.name,
    });
  };

  // Auto-print: once the hidden slip is in the DOM, send it to the printer. A
  // tick's delay lets the QR SVG and layout paint before the snapshot is taken.
  //
  // The slip has to stay mounted until the print job is REALLY over. On a
  // desktop browser window.print() blocks until the dialog closes, so clearing
  // on the next line was fine. On a phone it does NOT block: it returns at once
  // and the print sheet opens a moment later — so clearing there ripped the
  // slip out of the DOM before the phone had rendered it, and staff got a blank
  // print and a blank PDF. That is the whole reason printing worked on the
  // computer but not on the phone.
  //
  // So the clean-up waits for the browser to say it is done: `afterprint`, or
  // the print media query switching back off (what iOS reports), with a long
  // timer as a last resort for a browser that fires neither.
  useEffect(() => {
    if (!printData) return;
    let cleared = false;
    const finish = () => {
      if (cleared) return;
      cleared = true;
      setPrintData(null);
    };

    const start = setTimeout(() => window.print(), 120);
    const giveUp = setTimeout(finish, 60000);
    const printMedia = window.matchMedia?.('print');
    const onMedia = (e) => { if (!e.matches) finish(); };

    window.addEventListener('afterprint', finish);
    printMedia?.addEventListener?.('change', onMedia);
    return () => {
      clearTimeout(start);
      clearTimeout(giveUp);
      window.removeEventListener('afterprint', finish);
      printMedia?.removeEventListener?.('change', onMedia);
    };
  }, [printData]);

  // Settle one bill with the money type staff actually received (เงินสด / สแกน
  // QR / คนละครึ่ง). Frees the table immediately, replacing the old check-bill.
  //
  // Asks first, and names the money type in the question: the three buttons sit
  // side by side and settling is the one action on this screen that cannot be
  // undone — the bill is stamped paid, the table is freed for the next group and
  // the takings are filed under that method. A mis-tap picks the wrong one
  // silently, and the owner's report only shows it much later.
  const settleWithMethod = (order, method) => {
    const label = PAY_METHOD_LABELS[method] || method;
    const ok = confirm(
      `ยืนยันรับเงินด้วย "${label}" หรือไม่?\n\n` +
      `${tableLabel(order.table)} · ยอด ฿${(order.total || 0).toLocaleString()}\n` +
      'กดตกลงแล้วบิลจะปิดและโต๊ะจะว่างทันที'
    );
    if (!ok) return;
    settleBills([order.id], order.table, method);
  };

  // --- ส่วนลด (% หรือ บาท) ------------------------------------------------------
  // Open the box, pre-filled with whatever discount the bill already carries so
  // "10% → 15%" is a correction rather than a second discount stacked on top.
  // It opens in the MODE the existing discount was given in, for the same reason.
  const openDiscount = (order) => {
    const spec = discountSpec(billDiscount(order));
    setDiscountFor(order.id);
    setDiscountMode(spec?.mode || 'percent');
    setDiscountValue(spec?.value ? String(spec.value) : '');
  };

  // Confirming does not apply anything yet: a discount is money off the shop's
  // takings, so it is signed with a ไอดีพนักงาน exactly like a printed bill.
  const confirmDiscount = (order, spec) => {
    const value = Number(spec?.value);
    if (!Number.isFinite(value) || value < 0) {
      showToast('ส่วนลดต้องเป็นตัวเลขที่ไม่ติดลบ');
      return;
    }
    if (spec?.mode === 'percent' && value > 100) {
      showToast('ส่วนลดแบบเปอร์เซ็นต์ต้องอยู่ระหว่าง 0–100%');
      return;
    }
    const removing = value === 0;
    setPinAction({
      title: removing ? 'ใครเป็นคนยกเลิกส่วนลด?' : 'ใครเป็นคนให้ส่วนลดนี้?',
      detail: removing
        ? `${tableLabel(order.table)} — นำส่วนลดออกจากบิล`
        : `${tableLabel(order.table)} · ลด ${discountLabel(spec)} = -฿${discountAmount(order.items, spec).toLocaleString()}`,
      confirmLabel: removing ? 'ยกเลิกส่วนลด' : 'ให้ส่วนลด',
      run: (person) => applyDiscount(order.id, spec, person),
    });
  };

  const applyDiscount = (orderId, spec, person) => {
    let applied = null;
    setOrders(prev => prev.map(o => {
      // Recomputed against the bill as it stands NOW, not as it looked when the
      // box was opened — the table may have ordered another round in between.
      if (o.id !== orderId) return o;
      const next = withDiscount(o, spec, person?.name || '');
      applied = next;
      return next;
    }));
    setDiscountFor(null);
    setDiscountValue('');
    if (!applied) return;
    const line = billDiscount(applied);
    showToast(
      line
        ? `ให้ส่วนลด ${discountLabel(discountSpec(line))} (-฿${Math.abs(line.price).toLocaleString()}) โดย ${person?.name || 'พนักงาน'} · ยอดใหม่ ฿${(applied.total || 0).toLocaleString()}`
        : `นำส่วนลดออกจาก${tableLabel(applied.table)}แล้ว โดย ${person?.name || 'พนักงาน'}`
    );
  };

  // ยกเลิกบิล — send the table back to the un-checked-out state so the customer's
  // phone unlocks and they can order more. Nothing is settled.
  const cancelBill = (order) => {
    setOrders(prev => prev.map(o => (o.id === order.id ? { ...o, checkout: null } : o)));
    showToast(`ยกเลิกบิล โต๊ะ ${order.table} — ปลดล็อกให้ลูกค้าสั่งเพิ่มได้`);
  };

  const cancelOrder = (orderId) => {
    if (confirm('คุณต้องการยกเลิกออเดอร์นี้ใช่หรือไม่?')) {
      setOrders(prev => prev.map(o => {
        if (o.id === orderId) {
          showToast('ยกเลิกออเดอร์แล้ว');
          return { ...o, status: 'cancelled' };
        }
        return o;
      }));
    }
  };

  // Stock is deducted the moment a dish is marked เสิร์ฟแล้ว (สำเร็จ), by the
  // ordered qty — not when the order is placed. `stockDone` on the item keeps
  // this to exactly one deduction per dish; เสิร์ฟแล้ว is one-way, so the count
  // never has to be given back.
  const changeStockCount = (stockRef, delta) => {
    if (!stockRef || !delta) return;
    setStock(prev => {
      const s = prev[stockRef];
      if (!s) return prev;
      return { ...prev, [stockRef]: { ...s, count: s.count + delta } };
    });
  };

  // The menu-card name behind an order line, for matching a stock_items row by
  // name. Order names can carry a folded option — "ข้าวผัด (หมู)" — so prefer
  // the menu row via menuId and fall back to stripping that suffix. Custom
  // "เมนูอื่นๆ" items return null: they never touch stock.
  const linkedStockName = (item) => {
    // A ส่วนลด line is money, not a dish — it must never be looked up in, or
    // deducted from, the stock room.
    if (!item || item.menuId === 'custom' || isDiscountItem(item)) return null;
    const m = menu.find(mn => mn.id === item.menuId);
    if (m) return m.name;
    return String(item.name || '').replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
  };

  // Mirror a serve/un-serve into the SQL stock_items row (คลังวัตถุดิบ) with the
  // same name — the stock the customer storefront checks. Positive qty deducts,
  // negative restores; no matching row is a no-op on the server. A network
  // hiccup never blocks the serve tap — the error is logged and the tap stands.
  //
  // This resolves to the updated row (or null) rather than writing state itself,
  // so a caller cutting several dishes at once can fold every answer into ONE
  // state update. Writing per reply meant one re-render of the whole board per
  // dish, each landing at its own moment — invisible on localhost where they all
  // come back together, a visible stutter over a real network.
  //
  // A cut that fails is never dropped: it is queued and resent (retryStockCuts)
  // under the same opKey, so the server applies it exactly once, and the banner
  // tells staff the คลัง count is behind until it goes through.
  const consumeLinkedStockRow = (item, qty) => {
    const name = linkedStockName(item);
    if (!name || !qty) return Promise.resolve(null);
    const opKey = newStockOpKey();
    return consumeStockByName(name, qty, opKey).catch((err) => {
      console.error('[stock] ตัดสต็อกไม่สำเร็จ:', err.message || err);
      if (isPermanentStockError(err)) {
        showToast(`ตัดสต็อก "${name}" ไม่สำเร็จ: ${err.message} — กรุณาปรับในคลังเอง`);
      } else {
        queueStockCut({ name, qty, opKey });
        setPendingCuts(pendingStockCutCount());
        showToast(`ตัดสต็อก "${name}" ไม่สำเร็จ — ระบบจะลองใหม่อัตโนมัติ`);
      }
      return null;
    });
  };

  // Resend queued cuts: right away, whenever the device comes back online, and
  // every 20 s while anything is still waiting.
  const retryStockCuts = async () => {
    if (pendingStockCutCount() === 0) return;
    const { rows, sent, dropped } = await flushStockCuts(consumeStockByName);
    setPendingCuts(pendingStockCutCount());
    applyStockRows(rows);
    if (dropped.length > 0) {
      showToast(`ตัดสต็อกไม่สำเร็จ: ${dropped.map(d => `${d.qty}× ${d.name}`).join(', ')} — กรุณาปรับในคลังเอง`);
    } else if (sent > 0 && pendingStockCutCount() === 0) {
      showToast(`ตัดสต็อกที่ค้างไว้สำเร็จแล้ว (${sent} รายการ)`);
    }
  };
  const retryStockCutsRef = useRef(retryStockCuts);
  retryStockCutsRef.current = retryStockCuts;

  useEffect(() => {
    const run = () => retryStockCutsRef.current();
    run();
    const timer = setInterval(run, 20000);
    window.addEventListener('online', run);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', run);
    };
  }, []);

  // Fold a batch of updated stock rows into the คลังวัตถุดิบ list in one render.
  const applyStockRows = (rows) => {
    const byId = new Map((rows || []).filter(Boolean).map(r => [r.id, r]));
    if (byId.size === 0) return;
    setStockItems(prev => prev.map(it => byId.get(it.id) || it));
  };

  const consumeLinkedStock = (item, qty) => {
    consumeLinkedStockRow(item, qty).then(row => applyStockRows([row]));
  };

  // How many units of the stock behind a dish are on hand right now — used to
  // decide whether a serve tap is allowed. A dish can be tied to the in-memory
  // drink `stock` (stockRef) and/or a คลังวัตถุดิบ row matched by name; when
  // both apply, the tighter limit wins. Returns null for dishes with no linked
  // stock (custom / unmatched) — those never block.
  const availableStockFor = (item) => {
    const limits = [];
    if (item?.stockRef && stock[item.stockRef]) limits.push(stock[item.stockRef].count);
    const name = linkedStockName(item);
    if (name) {
      const row = stockItems.find(it => stockKey(it.name) === stockKey(name));
      if (row) limits.push(row.quantity);
    }
    return limits.length ? Math.min(...limits) : null;
  };

  // True when serving `item` would push its linked stock below zero — i.e. the
  // last units were already served to another bill. Un-served items (stockDone)
  // and non-stock dishes never block.
  const wouldOverdrawStock = (item) => {
    if (item.stockDone) return false;
    const avail = availableStockFor(item);
    return avail !== null && avail < item.qty;
  };

  // Set ONE dish on a bill to a chosen status (รับออเดอร์ / อยู่ในครัว /
  // เสิร์ฟแล้ว) from the per-item segmented control. The bill's own status is
  // re-derived from its items, so the board/customer keep in sync.
  const setItemStatusTo = (orderId, itemIndex, next) => {
    // Read the current item from props (not inside the updater) so the stock
    // side-effect fires exactly once even under React's double-invoked updaters.
    const order = orders.find(o => o.id === orderId);
    if (!order || order.status === 'paid' || order.status === 'cancelled') return;
    const item = order.items[itemIndex];
    const current = itemStatus(item);
    if (next === current) return;

    // เสิร์ฟแล้ว is the end of the line: the dish is on the table and its stock
    // is cut, so the status is frozen from here. The UI drops the segmented
    // control for a served dish; this guard holds the rule at the source.
    if (current === 'served') { showToast('เสิร์ฟแล้ว — แก้ไขสถานะไม่ได้อีก'); return; }

    const nowServed = next === 'served' && !item.stockDone;
    // Block serving once the stock is gone — another bill already took the last
    // units, so this dish is สินค้าหมดแล้ว and can't be marked เสิร์ฟแล้ว.
    if (nowServed && wouldOverdrawStock(item)) { showToast('สินค้าหมดแล้ว'); return; }

    // ...and because that last step cannot be taken back, ask before it. The
    // steps sit side by side in one small control, and a mis-tap on เสิร์ฟแล้ว
    // would otherwise lock the dish and cut its stock with nothing to undo it.
    if (next === 'served') {
      const ok = confirm(
        'ยืนยันว่า "เสิร์ฟแล้ว" หรือไม่?\n\n' +
        `${item.qty}× ${item.name}\n` +
        'กดตกลงแล้วจะแก้ไขสถานะของรายการนี้ไม่ได้อีก'
      );
      if (!ok) return;
    }

    if (nowServed) { changeStockCount(item.stockRef, -item.qty); consumeLinkedStock(item, item.qty); }

    setOrders(prev => prev.map(o => {
      if (o.id !== orderId) return o;
      const items = o.items.map((it, i) => {
        if (i !== itemIndex) return it;
        const upd = { ...it, status: next };
        if (nowServed) upd.stockDone = true;
        return upd;
      });
      return { ...o, items, status: deriveBillStatus(items) };
    }));
  };

  // One tap to send every not-yet-started dish on a bill into the kitchen
  // (รับออเดอร์ → อยู่ในครัว). Dishes already cooking/served are untouched, and
  // no stock moves here — stock only changes on เสิร์ฟแล้ว.
  const markBillCooking = (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order || order.status === 'paid' || order.status === 'cancelled') return;
    setOrders(prev => prev.map(o => {
      if (o.id !== orderId) return o;
      const items = o.items.map(it => (itemStatus(it) === 'new' ? { ...it, status: 'cooking' } : it));
      return { ...o, items, status: deriveBillStatus(items) };
    }));
  };

  // One tap to mark every dish on a bill served — handy when a whole table's
  // food goes out together instead of poking each row. Deducts stock for every
  // dish not already counted.
  const markBillServed = (orderId) => {
    const order = orders.find(o => o.id === orderId);
    if (!order || order.status === 'paid' || order.status === 'cancelled') return;

    // Same one-way step as the per-dish control, taken for a whole bill at once,
    // so it asks the same question — with the count, since this locks several
    // rows in one tap.
    const pending = order.items.filter(it => itemStatus(it) !== 'served' && !isDiscountItem(it));
    if (pending.length === 0) return;
    const ok = confirm(
      'ยืนยันว่า "เสิร์ฟแล้ว" ทั้งบิลหรือไม่?\n\n' +
      `${tableLabel(order.table)} · ${pending.length} รายการ\n` +
      'กดตกลงแล้วจะแก้ไขสถานะของรายการเหล่านี้ไม่ได้อีก'
    );
    if (!ok) return;

    // A dish counts as stock-linked via either inventory: the in-memory drink
    // `stock` (stockRef) or a stock_items row matched by name.
    const shouldDeduct = (it) => !it.stockDone && (it.stockRef || linkedStockName(it));
    // Any dish whose linked stock has already run dry can't go out — leave it
    // unserved and warn, rather than driving the count negative.
    const blocked = (it) => shouldDeduct(it) && wouldOverdrawStock(it);
    const toDeduct = order.items.filter(it => shouldDeduct(it) && !blocked(it));
    if (toDeduct.length > 0) {
      setStock(prev => {
        const next = { ...prev };
        toDeduct.forEach(it => {
          if (!it.stockRef) return;
          const s = next[it.stockRef];
          if (s) next[it.stockRef] = { ...s, count: s.count - it.qty };
        });
        return next;
      });
      // One render for the whole batch, not one per dish (see applyStockRows).
      Promise.all(toDeduct.map(it => consumeLinkedStockRow(it, it.qty))).then(applyStockRows);
    }

    setOrders(prev => prev.map(o => {
      if (o.id !== orderId) return o;
      const items = o.items.map(it => {
        if (blocked(it)) return it; // สินค้าหมดแล้ว — keep it unserved
        return {
          ...it,
          status: 'served',
          stockDone: shouldDeduct(it) ? true : it.stockDone,
        };
      });
      return { ...o, items, status: deriveBillStatus(items) };
    }));

    if (order.items.some(blocked)) showToast('สินค้าหมดแล้ว บางรายการยังเสิร์ฟไม่ได้');
  };

  const getItemStatusLabel = (status) => ITEM_STATUS_LABELS[status] || status;
  const getItemStatusColor = (status) => ITEM_STATUS_COLORS[status] || 'bg-neutral-100 text-neutral-600';

  const getStatusLabel = (status) => {
    switch (status) {
      case 'new': return 'รับออเดอร์';
      case 'cooking': return 'อยู่ในครัว';
      case 'served': return 'เสิร์ฟแล้ว';
      case 'paid': return 'เช็กบิลแล้ว';
      case 'cancelled': return 'ยกเลิก';
      default: return status;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'new': return 'bg-[#FDECC8] text-[#8a5a00]';
      case 'cooking': return 'bg-[#DCE9F7] text-[#2F5D8A]';
      // Same light brown as the per-dish 'served' chip (ITEM_STATUS_COLORS in
      // orders.js) — the card header and the dishes under it have to agree.
      case 'served': return 'bg-[#EADBC8] text-[#6B4A2B]';
      case 'paid': return 'bg-[#E9E5DB] text-[#6b6656]';
      case 'cancelled': return 'bg-[#F6DAD7] text-[#9a2c22]';
      default: return 'bg-neutral-100 text-neutral-600';
    }
  };

  // Direct order handlers
  const handleOpenDetail = (item, mode = 'cart') => {
    if (!item.available) return;
    setDetailMode(mode);
    setSelectedItem(item);
    // Default to the first protein/size the same way the customer dialog does.
    setSelectedOption(item.options && item.options.length ? item.options[0] : null);
    setModalQty(1);
    setModalNotes('');
    setSelectedAddons([]);
    setSelectedChoices(defaultChoices(extrasOf(item).choices));
  };

  const handleChoiceChange = (groupName, option) => {
    setSelectedChoices(prev => ({ ...prev, [groupName]: option }));
  };

  const handleAddonChange = (addonName, price, isChecked) => {
    if (isChecked) {
      setSelectedAddons(prev => [...prev, { name: addonName, price }]);
    } else {
      setSelectedAddons(prev => prev.filter(a => a.name !== addonName));
    }
  };

  const handleAddToCart = () => {
    if (!selectedItem) return;

    // Choices (ไซส์ L +5) ride on addonCost alongside addons, so bills and
    // kitchen tickets need no changes to understand them.
    const addonCost =
      selectedAddons.reduce((sum, a) => sum + a.price, 0) + choicesCost(selectedChoices);
    const chosenNames = Object.values(selectedChoices).map(o => o.name);

    // Protein/size (เนื้อสัตว์): its price becomes the base price, and its name is
    // folded into the dish name — "ข้าวกระเพรา (หมูสับ)" — so the kitchen ticket
    // and the bill both read the exact variant, matching the customer flow.
    const basePrice = selectedOption ? selectedOption.price : selectedItem.price;
    const lineName = selectedOption ? `${selectedItem.name} (${selectedOption.name})` : selectedItem.name;

    // When editing an existing bill, push straight into that bill. Tag the new
    // item with the bill's current last round so it stays grouped with it
    // rather than starting a stray divider.
    if (detailMode === 'editbill' && editingBill) {
      const lastRound = editingBill.items.reduce((m, it) => Math.max(m, itemRound(it)), 1);
      const items = [...editingBill.items, stampKitchenFields({
        name: lineName,
        menuId: selectedItem.id,
        group: selectedItem.group || 'food',
        // Heading rides along so serve-direct lines (cold towels, desserts,
        // snacks) get the 2-state flow like drinks — see isServeDirectItem.
        category: selectedItem.category,
        qty: modalQty,
        price: basePrice,
        addonCost: addonCost,
        addOns: [...chosenNames, ...selectedAddons.map(a => a.name)],
        note: modalNotes,
        round: lastRound,
        roundAt: Date.now(),
        stockRef: selectedItem.stockRef || null
      })];
      const total = items.reduce((sum, item) => sum + (item.price + (item.addonCost || 0)) * item.qty, 0);
      setEditingBill({ ...editingBill, items, total });
      setSelectedItem(null);
      showToast(`เพิ่ม ${selectedItem.name} ในบิลชั่วคราวแล้ว`);
      return;
    }

    const cartItem = {
      id: selectedItem.id + '_' + Date.now().toString(36),
      menuId: selectedItem.id,
      group: selectedItem.group || 'food',
      category: selectedItem.category,
      name: lineName,
      basePrice: basePrice,
      price: basePrice,
      addonCost: addonCost,
      qty: modalQty,
      addons: [...chosenNames, ...selectedAddons.map(a => a.name)],
      note: modalNotes,
      stockRef: selectedItem.stockRef || null
    };

    setTakeOrderCart(prev => [...prev, cartItem]);
    setSelectedItem(null);
    showToast(`เพิ่ม ${cartItem.name} ลงบิลเรียบร้อย`);
  };

  const handleRemoveDirectCartItem = (itemId) => {
    setTakeOrderCart(prev => prev.filter(item => item.id !== itemId));
  };

  // --- Custom "เมนูอื่นๆ" handlers -------------------------------------------
  const openCustomModal = () => {
    setCustomName('');
    setCustomPrice('');
    setCustomQty(1);
    setCustomNote('');
    setCustomTakeaway(false);
    setCustomExtras({
      'ไข่ดาว': { on: false, price: 10 },
      'ไข่เจียว': { on: false, price: 15 },
      'กับข้าว': { on: false, price: 20 }
    });
    setShowCustomModal(true);
  };

  const toggleCustomExtra = (name) => {
    setCustomExtras(prev => ({ ...prev, [name]: { ...prev[name], on: !prev[name].on } }));
  };

  const setCustomExtraPrice = (name, val) => {
    const price = Math.max(0, Number(val) || 0);
    setCustomExtras(prev => ({ ...prev, [name]: { ...prev[name], price } }));
  };

  // Selected extras (with their edited prices) + the sums used for the total.
  const customSelectedExtras = Object.entries(customExtras)
    .filter(([, v]) => v.on)
    .map(([name, v]) => ({ name, price: Number(v.price) || 0 }));
  const customAddonCost = customSelectedExtras.reduce((sum, e) => sum + e.price, 0);
  const customPriceNum = Number(customPrice) || 0;
  const customValid = customName.trim() !== '' && customPriceNum > 0;
  const customLiveTotal = (customPriceNum + customAddonCost) * customQty;

  const handleAddCustomToCart = () => {
    if (!customValid) return; // ชื่อห้ามว่าง, ราคา > 0
    // Extras carry their price in the label so the kitchen/bill shows both.
    const addonNames = customSelectedExtras.map(e => `${e.name} +฿${e.price}`);
    if (customTakeaway) addonNames.push('🏠 กลับบ้าน');

    const cartItem = {
      id: 'custom_' + Date.now().toString(36),
      menuId: 'custom',
      group: 'food',
      name: customName.trim(),
      basePrice: customPriceNum,
      price: customPriceNum,
      addonCost: customAddonCost,
      qty: customQty,
      addons: addonNames,
      note: customNote,
      stockRef: null // custom items never deduct stock
    };

    setTakeOrderCart(prev => [...prev, cartItem]);
    setShowCustomModal(false);
    showToast(`เพิ่ม ${cartItem.name} ลงบิลเรียบร้อย`);
  };

  const handlePlaceDirectOrder = () => {
    if (takeOrderCart.length === 0) return;

    // Validate stock. A dish can't be keyed past what its linked inventory
    // holds — both the in-memory drink `stock` (stockRef) and the คลังวัตถุดิบ
    // row matched by name. Several lines (or the same dish added twice) draw on
    // one stock, so sum the quantity requested per source across the WHOLE cart
    // before comparing, otherwise two lines each ≤ on-hand could still overdraw.
    const byRef = new Map();  // stockRef -> total qty requested
    const byName = new Map(); // linked stock name -> total qty requested
    for (const cartItem of takeOrderCart) {
      if (cartItem.stockRef) {
        byRef.set(cartItem.stockRef, (byRef.get(cartItem.stockRef) || 0) + cartItem.qty);
      }
      const name = linkedStockName(cartItem);
      if (name) byName.set(name, (byName.get(name) || 0) + cartItem.qty);
    }

    let shortage = null; // { name, want, have }
    for (const [ref, want] of byRef) {
      const s = stock[ref];
      if (s && s.count < want) { shortage = { name: s.name || ref, want, have: s.count }; break; }
    }
    if (!shortage) {
      for (const [name, want] of byName) {
        const row = stockItems.find(it => stockKey(it.name) === stockKey(name));
        if (row && row.quantity < want) { shortage = { name, want, have: row.quantity }; break; }
      }
    }

    if (shortage) {
      alert(`คลังสินค้าสำหรับ [${shortage.name}] ไม่เพียงพอ (ต้องการ ${shortage.want} เหลือ ${shortage.have}) ไม่สามารถลงบิลได้`);
      return;
    }

    // Stock is NOT deducted here — it comes off only when each dish is marked
    // เสิร์ฟแล้ว (สำเร็จ). We carry `stockRef` onto the order item so the serve
    // action knows what to subtract.
    const orderNo = generateOrderNo(orders);
    const directTotal = takeOrderCart.reduce((sum, item) => sum + (item.basePrice + item.addonCost) * item.qty, 0);
    const createdAt = Date.now();
    // The shop's clock decides the shift, NOT the menu this was typed from: a
    // day-menu order rung up at 18:00 is the night shop's takings, whichever
    // tab the person at the till happened to have open.
    const billShift = shiftNow();
    // Grab / กลับบ้าน never merge into an open bill — each order is its own
    // ticket. The number is picked here (rather than left to mergeOrder) so the
    // confirmation below can name the bill that was just opened.
    const channel = singleRoundBase(targetTable);
    const billTable = channel
      ? nextSingleRoundTable(orders, channel, { createdAt, type: billShift })
      : targetTable;
    const newOrder = {
      id: 'B' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      no: orderNo,
      time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
      createdAt,
      // Stamped from the shop clock (see billShift above), so the takings land
      // on the shop that was actually trading at that hour.
      type: billShift,
      table: billTable,
      items: takeOrderCart.map(item => ({
        name: item.name,
        menuId: item.menuId,
        group: item.group || 'food',
        category: item.category,
        qty: item.qty,
        price: item.basePrice,
        addonCost: item.addonCost,
        addOns: item.addons,
        note: item.note,
        stockRef: item.stockRef || null
      })),
      total: directTotal,
      status: 'new',
      note: takeOrderCart.map(i => i.note).filter(Boolean).join(' | '),
      by: 'พนักงาน:' + (activeStaffUser || 'Staff')
    };

    // Merge into the table's open bill (as a new round) if it hasn't checked
    // out yet; otherwise this opens a fresh bill.
    setOrders(prev => mergeOrder(prev, newOrder));
    setTakeOrderCart([]);
    showToast(`ลงบิล ${tableLabel(billTable)} สำเร็จแล้ว ✓`);
    setSubTab('orders');
  };

  // Edit Bill Modal handlers
  // Open the edit-bill modal for one bill. This used to be reached only from the
  // ผังโต๊ะ tab, which had to look a bill UP by table number; the board card
  // already IS the bill, so it is copied straight from the order. Deep copy —
  // the modal edits its own draft until บันทึก, so a cancel changes nothing.
  const openEditBill = (order) => {
    if (!order || order.status === 'paid' || order.status === 'cancelled') return;
    editBillBaseUids.current = new Set((order.items || []).map(it => it.uid).filter(Boolean));
    setEditingBill(JSON.parse(JSON.stringify(order)));
    setEditAddMenuId('');
    setShowMovePicker(false);
    setMoveConflict('');
  };

  // --- ย้ายโต๊ะ ---------------------------------------------------------------
  // Whether the "ย้ายโต๊ะ" table picker is expanded inside the edit-bill modal.
  const [showMovePicker, setShowMovePicker] = useState(false);
  // Set when the picked table already has an open bill: staff then choose
  // whether the two bills become one. Holds that table number, '' = no question
  // pending.
  const [moveConflict, setMoveConflict] = useState('');

  // Every open bill sitting at `table` right now (excluding the one being
  // edited). Used both to tint the picker and to find what to merge into.
  const openBillsAt = (table) => orders.filter((o) =>
    String(o.table) === String(table) &&
    o.status !== 'paid' && o.status !== 'cancelled' &&
    o.id !== editingBill?.id
  );

  // Move the bill being edited to another table. This is NOT part of the edit
  // draft: it saves immediately, because moving a table is a fact about the room
  // (the group got up and sat somewhere else), not a proposed change to the bill.
  //
  // The old table number is kept in `movedFrom` so the diner's phone — which is
  // pinned to the table it scanned — can follow the bill to its new number
  // instead of watching its own order disappear (see App.jsx).
  //
  // Tapping a table that already has a bill does NOT move anything yet: it asks
  // first (moveConflict), because "รวมบิล" and "แยกบิล" are both normal answers
  // and neither should be the silent default.
  const handleMoveTable = (to) => {
    if (!editingBill || !to) return;
    if (String(to) === String(editingBill.table)) { showToast('เป็นโต๊ะเดิมอยู่แล้ว'); return; }
    if (openBillsAt(to).length > 0) { setMoveConflict(String(to)); return; }
    moveBillTo(to);
  };

  // Carry the bill over as its own separate bill.
  const moveBillTo = (to) => {
    const from = String(editingBill.table);
    setOrders((prev) => prev.map((o) => (
      o.id === editingBill.id
        ? { ...o, table: String(to), movedFrom: [...(o.movedFrom || []), from], movedAt: Date.now() }
        : o
    )));
    // Keep the open modal pointed at the same bill, now under its new number.
    setEditingBill({ ...editingBill, table: String(to) });
    setShowMovePicker(false);
    setMoveConflict('');
    showToast(`ย้ายบิลจาก ${tableLabel(from)} ไป โต๊ะ ${to} แล้ว`);
  };

  // Combine this bill with the one already at `to`, so the joined tables pay as
  // one. The bill already sitting there is the one that survives (it keeps its
  // เลขที่บิล); the edited bill is folded into it and disappears, which is why
  // the editor closes afterwards — the record it was editing no longer exists.
  const mergeBillInto = (to) => {
    const from = String(editingBill.table);
    // If more than one bill is open there, join the earliest — the group that
    // has been at that table longest is the one the others are moving to.
    const target = openBillsAt(to).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
    if (!target) { showToast('ไม่พบบิลที่โต๊ะปลายทางแล้ว'); setMoveConflict(''); return; }

    setOrders((prev) => absorbBill(prev, editingBill.id, target.id));
    setEditingBill(null);
    setShowMovePicker(false);
    setMoveConflict('');
    showToast(`รวมบิล ${tableLabel(from)} เข้ากับ โต๊ะ ${to} เป็นบิลเดียวแล้ว (${target.no})`);
  };

  const editBillTotal = (items) =>
    items.reduce((sum, item) => sum + (item.price + (item.addonCost || 0)) * item.qty, 0);

  // Units added in the draft to a line whose stock was ALREADY cut (it was
  // served), measured against the live bill — those are cut on save.
  const extraServedQty = (draftItem, liveBill) => {
    const was = draftItem?.uid && (liveBill?.items || []).find(it => it.uid === draftItem.uid);
    return was && was.stockDone ? Math.max(0, draftItem.qty - was.qty) : 0;
  };

  const handleEditBillQty = (idx, val) => {
    if (!editingBill) return;
    const items = [...editingBill.items];
    // Adding to a served dish cuts stock for the extra units, so it is held to
    // the same rule as the serve tap: no more than the stock has left.
    if (val > 0) {
      const extra = extraServedQty(items[idx], orders.find(o => o.id === editingBill.id)) + val;
      const avail = items[idx].stockDone ? availableStockFor(items[idx]) : null;
      if (avail !== null && avail < extra) { showToast('สินค้าหมดแล้ว'); return; }
    }
    items[idx].qty = Math.max(1, items[idx].qty + val);
    setEditingBill({ ...editingBill, items, total: editBillTotal(items) });
  };

  const handleRemoveEditBillItem = (idx) => {
    if (!editingBill) return;
    const items = editingBill.items.filter((_, i) => i !== idx);
    setEditingBill({ ...editingBill, items, total: editBillTotal(items) });
  };

  const handleAddItemToEditBill = () => {
    if (!editAddMenuId || !editingBill) return;
    const item = orderableMenu.find(m => m.id === editAddMenuId);
    if (!item) return;
    // Open the same detail modal so staff can pick add-ons/notes/qty
    handleOpenDetail(item, 'editbill');
    setEditAddMenuId('');
  };

  // The draft is a copy taken when the modal opened. A round the table ordered
  // while it was open is not in it, and saving the draft as-is would silently
  // delete that round — so every line that arrived after the copy was taken is
  // carried over.
  const linesArrivedSinceEdit = (liveBill) => {
    const draftUids = new Set(editingBill.items.map(it => it.uid).filter(Boolean));
    return (liveBill?.items || []).filter(it =>
      it.uid && !editBillBaseUids.current.has(it.uid) && !draftUids.has(it.uid) && !isDiscountItem(it)
    );
  };

  const handleSaveEditedBill = () => {
    if (!editingBill) return;
    const live = orders.find(o => o.id === editingBill.id);
    if (editingBill.items.length === 0 && linesArrivedSinceEdit(live).length === 0) {
      // If all items removed, cancel the bill
      setOrders(prev => prev.map(o => {
        if (o.id === editingBill.id) {
          return { ...o, status: 'cancelled', items: [], total: 0 };
        }
        return o;
      }));
      showToast('ยกเลิกบิลสำเร็จเนื่องจากลบทุกรายการ');
    } else {
      // A served dish had its stock cut for the qty it had then. Raising that
      // qty here means more of it went out, so the extra units are cut now —
      // read from props, outside the updater, so it fires exactly once.
      const extras = editingBill.items
        .map(it => ({ it, qty: extraServedQty(it, live) }))
        .filter(x => x.qty > 0);
      if (extras.length > 0) {
        extras.forEach(({ it, qty }) => changeStockCount(it.stockRef, -qty));
        // One render for the whole batch (see applyStockRows).
        Promise.all(extras.map(({ it, qty }) => consumeLinkedStockRow(it, qty))).then(applyStockRows);
      }

      setOrders(prev => prev.map(o => {
        if (o.id === editingBill.id) {
          const arrived = linesArrivedSinceEdit(o);
          const items = [...editingBill.items, ...arrived];
          // Re-derive the bill status: a newly added 'new' dish reopens the
          // ticket for the kitchen even if earlier rounds were served.
          const saved = {
            ...o,
            items,
            total: arrived.length ? editBillTotal(items) : editingBill.total,
            status: deriveBillStatus(items),
          };
          // Editing changes what the bill comes to, so a ส่วนลด on it is
          // re-struck over the new subtotal and pushed back to the end — the
          // same rule a new round follows (see mergeOrder). What was asked for
          // (10%, or ฿45) and the name that authorised it are untouched: a
          // percentage follows the new subtotal, a baht amount stays put.
          const discount = billDiscount(saved);
          return discount ? withDiscount(saved, discountSpec(discount), discount.by) : saved;
        }
        return o;
      }));
      showToast('บันทึกแก้ไขบิลเสร็จสิ้น');
    }
    setEditingBill(null);
  };

  // Wipe any in-progress staff workspace still tied to a table, so a freshly
  // paid/cleared table starts clean for the next group — no old take-order cart,
  // no stale edit-bill modal bleeding one session's data into the next.
  const clearTableWorkspace = (table) => {
    const same = (t) => String(t) === String(table);
    if (editingBill && same(editingBill.table)) setEditingBill(null);
    if (same(targetTable)) setTakeOrderCart([]);
    // Close the item-detail modal if it was opened for this table's flow.
    if (
      selectedItem &&
      ((detailMode === 'editbill' && editingBill && same(editingBill.table)) ||
        (detailMode === 'cart' && same(targetTable)))
    ) {
      setSelectedItem(null);
    }
  };

  // --- คลังวัตถุดิบ (SQL stock_items) ---------------------------------------
  // Load the inventory from the database whenever the tab is opened.
  const loadStockItems = async () => {
    setStockLoading(true);
    setStockError('');
    try {
      setStockItems(await fetchStockItems());
    } catch (err) {
      setStockError(err.message || 'โหลดคลังวัตถุดิบไม่สำเร็จ');
    } finally {
      setStockLoading(false);
    }
  };

  useEffect(() => {
    // รับออเดอร์ needs the live คลังวัตถุดิบ counts too, so a dish can't be keyed
    // past what its linked stock holds (see handlePlaceDirectOrder).
    if (subTab === 'stock' || subTab === 'take-order') loadStockItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab]);

  // Add `amount` to one item, persisting to the database. Updates the row in
  // place from the server's returned quantity (kept accurate even if two staff
  // edit at once).
  const adjustStockItemQty = async (id, amount, reason) => {
    try {
      const updated = await adjustStockItem(id, amount, reason);
      setStockItems((prev) => prev.map((it) => (it.id === id ? updated : it)));
      const sign = amount > 0 ? `+${amount}` : `${amount}`;
      showToast(`${updated.name} ${sign} (คงเหลือ ${updated.quantity})`);
    } catch (err) {
      showToast(err.message || 'ปรับจำนวนคลังไม่สำเร็จ');
    }
  };

  // The -1 (and any manual removal) opens a popup asking where the units went —
  // e.g. เจ้าของดื่มเอง / ของเสีย / ทำหล่น — so a shrinking count is always
  // accountable in the history. `removeTarget` holds the item + amount being
  // removed while the popup is open. { item, amount } | null
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeReason, setRemoveReason] = useState('');
  // The black "กรอกเลข" button opens a popup asking how many units to add.
  // `addTarget` holds the item while that popup is open; `addInput` is the
  // typed amount, kept as digits-only text so only positive integers get in.
  const [addTarget, setAddTarget] = useState(null);
  const [addInput, setAddInput] = useState('');

  // Quick-pick reasons for a stock removal; the free-text box covers anything
  // else. Tapping a chip just fills that same box, so either path is one field.
  const REMOVE_REASONS = ['เจ้าของ/พนักงานทานเอง', 'ของเสีย/หมดอายุ', 'ทำหล่น/แตกเสียหาย', 'ปรับยอดให้ตรงจริง'];

  // Open the reason popup for removing `amount` units of `item`.
  const askRemoveReason = (item, amount = 1) => {
    setRemoveReason('');
    setRemoveTarget({ item, amount });
  };

  // Confirm the removal with the chosen reason, then close the popup.
  const confirmRemove = async () => {
    if (!removeTarget) return;
    const { item, amount } = removeTarget;
    const reason = removeReason.trim();
    if (!reason) { showToast('กรุณาระบุเหตุผลที่นำออก'); return; }
    setRemoveTarget(null);
    await adjustStockItemQty(item.id, -Math.abs(amount), reason);
  };

  // Open the "type an amount to add" popup for `item`.
  const askAddAmount = (item) => {
    setAddInput('');
    setAddTarget(item);
  };

  // Add the typed amount to the item, then close the popup. Only whole
  // positive numbers are accepted — removals go through askRemoveReason so a
  // shrinking count always carries a reason.
  const confirmAdd = async () => {
    if (!addTarget) return;
    const amount = Number.parseInt(addInput, 10);
    if (!Number.isInteger(amount) || amount <= 0) { showToast('กรุณากรอกจำนวนเต็มบวก'); return; }
    const item = addTarget;
    setAddTarget(null);
    await adjustStockItemQty(item.id, amount);
  };

  // Open the ประวัติ panel on the working day in progress; the date bar inside
  // it steps back through earlier days.
  const openStockHistory = () => {
    setShowStockHistory(true);
    setHistoryDate(workdayKey());
  };

  const renderActiveSubTab = () => {
    switch (subTab) {
      case 'kitchen':
        return (
          <KitchenBoard
            orders={orders}
            setOrders={setOrders}
            menu={menu}
            showToast={showToast}
          />
        );
      case 'orders':
        const filteredOrders = getFilteredOrders();
        return (
          <div className="space-y-4">
            {/* One unified board — day and night orders together (the shift
                split was removed). Tabs below screen by status only. */}
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
              {[
                { k: 'active', l: 'กำลังทำงาน (ค้างชำระ)' },
                { k: 'paid', l: 'ชำระเงินแล้ว' },
                { k: 'all', l: 'ทั้งหมด' }
              ].map(f => (
                <button
                  key={f.k}
                  onClick={() => setOrderFilter(f.k)}
                  className={`px-3.5 py-1.5 rounded-full font-bold text-xs whitespace-nowrap transition border ${f.k === orderFilter ? 'bg-ctl border-ctl text-ctl-ink' : 'bg-admin-card border-neutral-200 text-neutral-500'}`}
                >
                  {f.l}
                </button>
              ))}
            </div>

            {filteredOrders.length > 0 ? (
              // One column on a phone; two on a desktop, where a single column
              // stretched across a monitor wastes the screen.
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-start">
                {filteredOrders.map(order => (
                  <div key={order.id} className="border border-neutral-200 bg-admin-card rounded-2xl p-4 shadow-xs relative">
                    <div className="flex justify-between items-center border-b pb-2 mb-2">
                      <div className="flex items-center gap-2">
                        {/* A Grab/กลับบ้าน ticket carries its own number
                            (Grab#2) and is tinted differently, so a delivery
                            bill is never mistaken for a seated table. */}
                        <span className={`font-extrabold text-[11px] px-2 py-0.5 rounded-md font-kanit ${singleRoundBase(order.table) ? 'bg-violet-600 text-white' : 'bg-ctl text-ctl-ink'}`}>
                          {tableLabel(order.table)}
                        </span>
                        <span className="font-mono text-neutral-400 text-xs font-semibold">{order.no}</span>
                      </div>
                      {/* The four-step status row under every dish already says
                          where the bill is, so this corner is the edit button
                          rather than a second read-out of the same thing. The
                          badge is kept ONLY for the two whole-bill states that
                          row cannot show — ชำระแล้ว and ยกเลิก — which are also
                          exactly the bills that cannot be edited. */}
                      {order.status === 'paid' || order.status === 'cancelled' ? (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${getStatusColor(order.status)}`}>
                          {getStatusLabel(order.status)}
                        </span>
                      ) : (
                        <div className="flex items-center gap-0.5 -mr-1">
                          {/* ส่วนลด — sits next to แก้ไขบิล because both change what
                              the table owes; this one needs a ไอดีพนักงาน, so it
                              is deliberately its own button rather than an
                              option buried inside the bill editor. */}
                          <button
                            onClick={() => openDiscount(order)}
                            title="ให้ส่วนลด (% หรือ บาท)"
                            aria-label="ให้ส่วนลด"
                            className={`p-1.5 rounded-lg transition active:scale-95 ${
                              billDiscount(order)
                                ? 'text-rose-600 bg-rose-50 hover:bg-rose-100'
                                : 'text-neutral-400 hover:text-rose-600 hover:bg-rose-500/10'
                            }`}
                          >
                            <TicketPercent className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => openEditBill(order)}
                            title="แก้ไขบิล (เพิ่ม / ลบ / แก้จำนวน)"
                            aria-label="แก้ไขบิล"
                            className="p-1.5 rounded-lg text-neutral-400 hover:text-amber-700 hover:bg-amber-500/10 transition active:scale-95"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    {order.invoiceNo && (
                      <div className="-mt-1 mb-2 text-[10px] font-mono font-bold text-amber-700">
                        เลขที่บิล: {order.invoiceNo}
                      </div>
                    )}

                    <div className="space-y-1.5 py-1">
                      {order.items.map((item, idx) => {
                        // Divider between ordering rounds merged into this bill.
                        const showRoundDivider = idx > 0 && itemRound(item) !== itemRound(order.items[idx - 1]);
                        // A discount is a bill line, not a dish: it gets no
                        // quantity, no kitchen steps and its own colour, so it
                        // never reads as something waiting to be cooked.
                        if (isDiscountItem(item)) {
                          return (
                            <div
                              key={idx}
                              className="flex justify-between items-center gap-2 text-xs font-thai font-bold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2 py-1.5"
                            >
                              <span className="flex items-center gap-1.5 min-w-0">
                                <TicketPercent className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">
                                  {item.name}
                                  {item.by && <span className="font-medium text-rose-500"> · โดย {item.by}</span>}
                                </span>
                              </span>
                              <span className="font-mono shrink-0">-฿{Math.abs(item.price).toLocaleString()}</span>
                            </div>
                          );
                        }
                        return (
                          <React.Fragment key={idx}>
                            {showRoundDivider && (
                              <div className="flex items-center gap-2 pt-1 text-[9px] text-neutral-400 font-semibold">
                                <span className="h-px flex-1 bg-neutral-200" />
                                สั่งเพิ่ม · รอบที่ {itemRound(item)}
                                <span className="h-px flex-1 bg-neutral-200" />
                              </div>
                            )}
                            {/* Two lines per dish: the dish + its price, then the
                                status on a line of its own. Squeezed beside the
                                price the four steps were 9px and clipped; given
                                the full width they are readable and tappable. */}
                            <div className="space-y-1 pb-0.5">
                              <div className="flex justify-between items-start gap-2 text-xs font-thai text-neutral-800">
                                <div className="min-w-0">
                                  <span className="font-bold text-amber-700 mr-1.5">{item.qty}×</span>
                                  <span>{item.name}</span>
                                  {item.addOns && item.addOns.length > 0 && (
                                    <p className="text-[9px] text-neutral-400 pl-5">พิเศษ: {item.addOns.join(', ')}</p>
                                  )}
                                  {item.note && (
                                    <p className="text-[9px] text-red-500 italic pl-5">📝 {item.note}</p>
                                  )}
                                </div>
                                <span className="font-mono text-neutral-500 font-medium text-xs flex-shrink-0">
                                  ฿{(item.price + (item.addonCost || 0)) * item.qty}
                                </span>
                              </div>

                              {/* A served dish is final — it loses the segmented
                                  control and keeps only its chip, the same as a
                                  dish on a paid/cancelled bill. */}
                              {order.status === 'paid' || order.status === 'cancelled' || itemStatus(item) === 'served' ? (
                                <div className="flex justify-end">
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${getItemStatusColor(itemStatus(item))}`}>
                                    {getItemStatusLabel(itemStatus(item))}
                                  </span>
                                </div>
                              ) : (
                                /* Segmented per-dish status: every step visible, tap to set. */
                                <div className="flex rounded-full border border-neutral-200 overflow-hidden">
                                  {statusFlowFor(item).map(s => {
                                    // The เสิร์ฟแล้ว step is locked out once the
                                    // linked stock is gone — the dish is หมดแล้ว
                                    // and another bill took the last units.
                                    const outOfStock = s === 'served' && itemStatus(item) !== 'served' && wouldOverdrawStock(item);
                                    return (
                                      <button
                                        key={s}
                                        onClick={() => setItemStatusTo(order.id, idx, s)}
                                        disabled={outOfStock}
                                        className={`flex-1 text-[10px] font-bold py-1 transition active:scale-95 ${itemStatus(item) === s ? getItemStatusColor(s) : outOfStock ? 'bg-admin-card text-neutral-200 cursor-not-allowed' : 'bg-admin-card text-neutral-300 hover:text-neutral-500'}`}
                                        title={outOfStock ? 'สินค้าหมดแล้ว' : `เปลี่ยนสถานะเป็น ${getItemStatusLabel(s)}`}
                                      >
                                        {outOfStock ? 'สินค้าหมดแล้ว' : getItemStatusLabel(s)}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>

                    <div className="border-t border-neutral-100 mt-2.5 pt-2 flex justify-between items-center text-xs">
                      <span className="text-[10px] text-neutral-400 font-medium">{order.time} น. · {order.by}</span>
                      <b className="font-mono text-neutral-800 font-extrabold">฿{order.total.toLocaleString()}</b>
                    </div>

                    {/* Status + check-bill actions */}
                    {order.status !== 'paid' && order.status !== 'cancelled' && (
                      <div className="mt-3 pt-2.5 border-t border-neutral-50 space-y-2">
                        {/* Whole-bill quick steps: send everything to the kitchen /
                            mark everything served — hidden once no dish needs them. */}
                        {order.items.some(it => itemStatus(it) !== 'served') && (
                          <div className="flex gap-2">
                            {order.items.some(it => itemStatus(it) === 'new') && (
                              <button
                                onClick={() => markBillCooking(order.id)}
                                className="flex-1 bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 font-bold py-2 rounded-xl text-xs transition"
                              >
                                🍳 ส่งเข้าครัวทุกจาน
                              </button>
                            )}
                            <button
                              onClick={() => markBillServed(order.id)}
                              className="flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 font-bold py-2 rounded-xl text-xs transition"
                            >
                              ✓ เสิร์ฟครบทุกจาน
                            </button>
                          </div>
                        )}
                        {(() => {
                          const stage = checkoutStage(order);
                          // พิมพ์บิลได้เมื่อเสิร์ฟครบทุกจาน — the "✓ เสิร์ฟครบทุกจาน"
                          // button right above is the one-tap way out of this.
                          const remaining = unservedItems(order).length;
                          const canPrint = remaining === 0;
                          const printClass = canPrint
                            ? 'bg-amber-600 hover:bg-amber-700 text-white'
                            : 'bg-neutral-100 text-neutral-400 border border-neutral-200 cursor-not-allowed';
                          const notServedNote = (
                            <p className="text-[10px] font-bold text-center text-amber-800 bg-amber-50 border border-amber-200 rounded-lg py-1.5">
                              ⏳ ยังเสิร์ฟไม่ครบ (เหลือ {remaining} รายการ) — เสิร์ฟครบก่อนถึงพิมพ์บิลได้
                            </p>
                          );

                          // Receipt printed → pick the money actually received.
                          if (stage === 'printed') {
                            return (
                              <div className="space-y-2">
                                <p className="text-[10px] font-bold text-center text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg py-1.5">
                                  🧾 พิมพ์บิลแล้ว
                                  {/* Who signed for it, so a question about this
                                      slip has an answer on the board itself. */}
                                  {order.printedBy?.name && <> โดย {order.printedBy.name}</>}
                                  {' '}· เลือกประเภทเงินที่ได้รับจริงเพื่อปิดโต๊ะ
                                </p>
                                <div className="grid grid-cols-3 gap-1.5">
                                  <button
                                    onClick={() => settleWithMethod(order, 'cash')}
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 rounded-xl text-[11px] leading-tight transition"
                                  >
                                    💵<br />เงินสด
                                  </button>
                                  <button
                                    onClick={() => settleWithMethod(order, 'qr')}
                                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded-xl text-[11px] leading-tight transition"
                                  >
                                    📱<br />สแกน QR
                                  </button>
                                  <button
                                    onClick={() => settleWithMethod(order, 'split')}
                                    className="bg-orange-500 hover:bg-orange-600 text-white font-bold py-2 rounded-xl text-[11px] leading-tight transition"
                                  >
                                    🇹🇭<br />ไทยช่วยไทย
                                  </button>
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => requestPrintBill(order)}
                                    className="flex-1 flex items-center justify-center gap-1 border border-neutral-200 hover:bg-neutral-50 text-neutral-600 font-bold py-2 rounded-xl text-xs transition"
                                  >
                                    <Printer className="w-3.5 h-3.5" /> พิมพ์ซ้ำ
                                  </button>
                                  <button
                                    onClick={() => cancelBill(order)}
                                    className="flex-1 flex items-center justify-center gap-1 border border-amber-200 hover:bg-amber-50 text-amber-700 font-bold py-2 rounded-xl text-xs transition"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" /> ยกเลิกบิล (สั่งเพิ่ม)
                                  </button>
                                </div>
                              </div>
                            );
                          }

                          // Customer asked to check out → alert staff + print.
                          if (stage === 'requested') {
                            const isSplit = order.checkout?.type === 'split';
                            return (
                              <div className="space-y-2">
                                <div className="flex items-start gap-2 text-[11px] font-bold text-amber-900 bg-amber-100 border border-amber-300 rounded-lg px-2.5 py-2">
                                  <Bell className="w-4 h-4 shrink-0 mt-0.5" />
                                  <span>
                                    {tableLabel(order.table)} ขอเช็กบิล · {CHECKOUT_TYPE_LABELS[order.checkout?.type] || 'เช็กบิลปกติ'}
                                    {isSplit && ' — อย่าลืมหยิบโทรศัพท์ร้าน (แอปถุงเงิน)'}
                                  </span>
                                </div>
                                {!canPrint && notServedNote}
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => requestPrintBill(order)}
                                    disabled={!canPrint}
                                    className={`flex-1 flex items-center justify-center gap-1.5 font-bold py-2 rounded-xl text-xs transition ${printClass}`}
                                  >
                                    <Printer className="w-4 h-4" /> พิมพ์บิล
                                  </button>
                                  <button
                                    onClick={() => cancelBill(order)}
                                    className="px-3 border border-neutral-200 hover:bg-neutral-50 text-neutral-500 font-bold py-2 rounded-xl text-xs transition"
                                  >
                                    ยกเลิก
                                  </button>
                                </div>
                              </div>
                            );
                          }

                          // Open bill (incl. staff-initiated "เก็บเงินด้วยค่ะ").
                          return (
                            <div className="space-y-2">
                              {!canPrint && notServedNote}
                              <div className="flex gap-2">
                                <button
                                  onClick={() => requestPrintBill(order)}
                                  disabled={!canPrint}
                                  className={`flex-1 flex items-center justify-center gap-1.5 font-bold py-2 rounded-xl text-xs transition ${printClass}`}
                                >
                                  <Printer className="w-4 h-4" /> พิมพ์บิล / เช็กบิล
                                </button>
                                <button
                                  onClick={() => cancelOrder(order.id)}
                                  className="px-3 border border-neutral-200 hover:bg-neutral-50 text-neutral-500 font-bold py-2 rounded-xl text-xs transition"
                                >
                                  ยกเลิก
                                </button>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {/* A settled bill is final — it only reports which money came
                        in. (The "ดึงโต๊ะกลับ" re-open button used to sit here.) */}
                    {order.status === 'paid' && (
                      <div className="mt-3 pt-2.5 border-t border-neutral-50">
                        <span className="text-[10px] text-neutral-400 font-medium">
                          {order.payMethod ? `รับชำระ: ${PAY_METHOD_LABELS[order.payMethod] || order.payMethod}` : 'ชำระเงินแล้ว'}
                          {order.printedBy?.name && ` · พิมพ์บิลโดย ${order.printedBy.name}`}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-neutral-400 text-xs font-medium">ไม่มีรายการออเดอร์ในหมวดหมู่ที่เลือก</div>
            )}
          </div>
        );

      case 'take-order':
        return (
          // Stacked on a phone (pick dishes, then scroll to the bill). On a
          // desktop the two sit side by side, so the bill stays in sight while
          // dishes are still being added.
          <div className="space-y-4 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-4 lg:items-start">
            <div className="bg-admin-card border rounded-2xl p-4 space-y-3 shadow-xs">
              <div>
                <label className="block text-xs font-bold text-neutral-400 mb-1 uppercase">เลือกโต๊ะที่ต้องการรับออเดอร์</label>
                <select 
                  value={targetTable}
                  onChange={e => setTargetTable(e.target.value)}
                  className="w-full border rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-amber-500 bg-neutral-50 font-bold text-xs"
                >
                  {Array.from({ length: settings.tables }, (_, i) => (
                    <option key={i+1} value={String(i+1)}>โต๊ะ {i+1}</option>
                  ))}
                  {/* Not seats — order channels. Each order placed against one
                      of these opens its OWN numbered bill (Grab#1, Grab#2 …)
                      instead of merging, so two riders never share a bill. */}
                  <option value={TAKEAWAY_TABLE}>สั่งกลับบ้าน / Takeaway</option>
                  <option value={GRAB_TABLE}>Grab / เดลิเวอรี</option>
                </select>
                {/* Says the rule out loud at the moment it applies, so nobody
                    waits for a second round to merge and wonders where it went. */}
                {singleRoundBase(targetTable) && (
                  <p className="mt-1.5 text-[10px] text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-2 py-1.5 font-medium">
                    ลงบิลครั้งนี้จะเปิดบิลใหม่เป็น <b>{nextSingleRoundTable(orders, singleRoundBase(targetTable), { createdAt: Date.now(), type: shiftNow() })}</b> —
                    ออเดอร์ของแต่ละรายจะไม่รวมกัน ถ้าต้องการเพิ่มรายการในบิลเดิม ให้กด “แก้ไขบิล” ที่หน้าบอร์ด
                  </p>
                )}
              </div>

              {/* ค้นหาเมนู — searches THIS SHIFT's menu across every category,
                  food and drink alike, no chip or dropdown needed. Typing is
                  forgiving (tone marks, spaces and small typos are ignored) —
                  see menu-search.js. Clears back to browsing when emptied. */}
              <div className="pt-1 relative">
                <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={directSearch}
                  onChange={e => setDirectSearch(e.target.value)}
                  placeholder="ค้นหาเมนู (พิมพ์อะไรก็เจอ)..."
                  className="w-full border rounded-xl p-3 pl-9 pr-9 focus:outline-none focus:ring-2 focus:ring-amber-500 bg-neutral-50 font-bold text-xs font-thai"
                />
                {directSearch && (
                  <button
                    onClick={() => setDirectSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 p-0.5 rounded hover:bg-neutral-200"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Which menu is on screen. Half the dishes are hidden by the
                  shift, so this says which half — otherwise a missing ข้าวผัด
                  reads as a bug rather than as "that one is on the other menu". */}
              <p className="text-[10px] text-neutral-500 bg-neutral-100 border border-neutral-200 rounded-lg px-2 py-1.5 font-medium font-thai">
                กำลังรับออเดอร์จาก <b>เมนู{SHIFT_LABELS[theme]}</b>
                {directSearch.trim() ? ' — ค้นหาทุกหมวดหมู่ในเมนูนี้' : ' — สลับตามเวลาโดยอัตโนมัติ'}
              </p>

              {directSearch.trim() ? null : (
                <div className="space-y-1.5 pt-1">
                  {/* ประเภท — the only browse filter. There is no day/night
                      switch on purpose: the shift is the clock's to decide, not
                      something staff should be able to key an order against. */}
                  <div className="flex gap-1.5">
                    {[
                      ['all', 'ทุกประเภท'],
                      ['food', GROUP_LABELS.food],
                      ['drink', GROUP_LABELS.drink],
                    ].map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => setDirectGroup(val)}
                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold font-thai border transition bg-transparent ${
                          directGroup === val
                            ? 'text-amber-700 border-amber-500 ring-1 ring-amber-500'
                            : 'text-neutral-500 border-neutral-200 hover:text-neutral-700'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Categories — a dropdown so a long list stays compact. It
                      opens on ทุกหมวดหมู่: not picking one shows everything
                      rather than hiding the menu behind a choice. */}
                  <select
                    value={directCat || ''}
                    onChange={e => setDirectCat(e.target.value || null)}
                    className="w-full border rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-amber-500 bg-neutral-50 font-bold text-xs font-thai"
                  >
                    <option value="">ทุกหมวดหมู่ ({browsableMenu.length} รายการ)</option>
                    {categories.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Quick Item List */}
              <div className="divide-y divide-neutral-100 max-h-56 lg:max-h-96 overflow-y-auto">
                {(() => {
                  const q = directSearch.trim();
                  const dishes = q
                    ? searchMenu(shiftMenu, q)
                    : directCat
                      ? browsableMenu.filter(m => m.category === directCat)
                      : browsableMenu;
                  if (dishes.length === 0) {
                    return (
                      <p className="py-6 text-center text-neutral-400 font-thai text-xs">
                        ไม่พบเมนูที่ค้นหา
                      </p>
                    );
                  }
                  return dishes.map(dish => {
                  const qty = takeOrderCart.filter(i => i.menuId === dish.id).reduce((s, i) => s + i.qty, 0);
                  // A dish with เนื้อสัตว์ / ขนาด options spans a price range;
                  // show it as ฿50–70 rather than picking one number to print.
                  const prices = (dish.options || []).map(o => o.price);
                  const lo = prices.length ? Math.min(...prices) : dish.price;
                  const hi = prices.length ? Math.max(...prices) : dish.price;
                  return (
                    <div key={dish.id} className="py-2.5 flex items-center justify-between gap-2 font-thai text-xs">
                      <div className="min-w-0">
                        <span className="font-bold text-neutral-800 block">
                          {dish.name}
                          {qty > 0 && <span className="ml-1.5 text-[10px] text-amber-600 font-mono">(ในบิล {qty})</span>}
                        </span>
                        <span className="flex items-center gap-1.5 flex-wrap mt-0.5">
                          <span className="text-neutral-400 font-mono">
                            ฿{lo}{hi > lo ? `–${hi}` : ''}
                          </span>
                          <span className="text-[9px] text-neutral-400">{dish.category}</span>
                        </span>
                      </div>

                      <button
                        onClick={() => handleOpenDetail(dish, 'cart')}
                        className="bg-ctl hover:bg-ctl-hover text-ctl-ink font-bold px-3 py-1.5 rounded-lg transition text-[11px] disabled:opacity-40 flex-shrink-0"
                        disabled={!dish.available}
                      >
                        {dish.available ? '+ เลือก' : 'หมด'}
                      </button>
                    </div>
                  );
                  });
                })()}
              </div>

              {/* Custom item entry — staff types a menu item that isn't listed */}
              <button
                onClick={openCustomModal}
                className="w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-neutral-300 hover:border-amber-500 hover:bg-amber-500/10 text-neutral-600 hover:text-amber-700 font-bold py-2.5 rounded-xl transition text-xs"
              >
                <Plus className="w-4 h-4" />
                <span>เมนูอื่นๆ (คีย์เอง)</span>
              </button>
            </div>

            {/* Direct Cart Summary */}
            {takeOrderCart.length > 0 && (
              <div className="bg-admin-card border rounded-2xl p-4 space-y-3.5 shadow-xs font-thai text-xs">
                <div className="flex justify-between items-center font-kanit font-extrabold text-sm text-neutral-800">
                  <span>สรุปรายการสั่งซื้อ ({tableLabel(targetTable)})</span>
                  <span className="font-mono text-amber-600">฿{takeOrderCart.reduce((sum, item) => sum + (item.basePrice + item.addonCost) * item.qty, 0).toLocaleString()}</span>
                </div>

                <div className="space-y-1 divide-y divide-neutral-50">
                  {takeOrderCart.map(item => (
                    <div key={item.id} className="flex justify-between items-start py-1.5 text-neutral-600">
                      <div className="pr-3">
                        <span>{item.name} (x{item.qty})</span>
                        {item.addons.length > 0 && (
                          <p className="text-[10px] text-neutral-400">พิเศษ: {item.addons.join(', ')}</p>
                        )}
                        {item.note && (
                          <p className="text-[10px] text-red-500 italic">📝 {item.note}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="font-mono">฿{(item.basePrice + item.addonCost) * item.qty}</span>
                        <button
                          onClick={() => handleRemoveDirectCartItem(item.id)}
                          className="text-red-500 hover:text-red-700 p-0.5 rounded hover:bg-red-500/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={handlePlaceDirectOrder}
                  className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition text-center"
                >
                  ยืนยันออเดอร์ส่งเข้าครัว
                </button>
              </div>
            )}
          </div>
        );

      case 'stock': {
        // Warn when an item drops to this many units or fewer (stock_items has
        // no per-item threshold column, so one shared level is used).
        const LOW_STOCK = 5;
        // Search + sort. Fewest units first, so anything หมดแล้ว (0) / ใกล้หมด
        // floats to the very top where it needs attention. The old per-category
        // grouping is dropped in favour of that single ordering; the category is
        // kept as a search key only — it is no longer drawn on the row.
        const q = stockSearch.trim().toLowerCase();
        const visibleStock = stockItems
          .filter((it) =>
            !q ||
            it.name.toLowerCase().includes(q) ||
            (it.category || '').toLowerCase().includes(q)
          )
          .sort((a, b) => (a.quantity - b.quantity) || a.name.localeCompare(b.name, 'th'));
        return (
          <div className="space-y-4">
            <div className="flex justify-between items-center gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <h2 className="font-extrabold text-sm font-kanit uppercase tracking-wider text-neutral-400">คลังวัตถุดิบ</h2>
                <button
                  onClick={openStockHistory}
                  className="flex items-center gap-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 border font-bold py-1.5 px-3 rounded-xl text-xs transition"
                  title="ดูประวัติการบันทึกสต็อก"
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span>ประวัติ</span>
                </button>
              </div>
            </div>

            {/* SEARCH — filters by item name or category */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                value={stockSearch}
                onChange={(e) => setStockSearch(e.target.value)}
                placeholder="ค้นหารายการในคลัง"
                className="w-full border rounded-xl py-2.5 pl-9 pr-3 bg-admin-field text-xs focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold font-thai"
              />
            </div>

            {stockLoading && (
              <div className="p-6 text-center text-xs text-neutral-400 font-thai">กำลังโหลดคลังวัตถุดิบ…</div>
            )}
            {stockError && !stockLoading && (
              <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-2xl text-xs font-thai flex items-center justify-between gap-3">
                <span>{stockError}</span>
                <button onClick={loadStockItems} className="font-bold underline shrink-0">ลองใหม่</button>
              </div>
            )}
            {!stockLoading && !stockError && stockItems.length === 0 && (
              <div className="p-6 text-center text-xs text-neutral-400 font-thai">ยังไม่มีข้อมูลในตาราง stock_items</div>
            )}
            {!stockLoading && !stockError && stockItems.length > 0 && visibleStock.length === 0 && (
              <div className="p-6 text-center text-xs text-neutral-400 font-thai">ไม่พบรายการที่ค้นหา</div>
            )}

            {!stockLoading && !stockError && visibleStock.length > 0 && (
              <div className="bg-admin-card border rounded-2xl overflow-hidden shadow-xs divide-y divide-neutral-100">
                {visibleStock.map((item) => {
                  const isOut = item.quantity <= 0;
                  const isLow = !isOut && item.quantity <= LOW_STOCK;
                  const img = resolveImageUrl(item.imageUrl);
                  return (
                    <div key={item.id} className="p-3.5 flex justify-between items-center text-xs font-thai">
                      <div className="flex items-center gap-3 min-w-0">
                        {img && (
                          <img src={img} alt="" width={40} height={40} className="w-10 h-10 rounded-lg object-cover border shrink-0" loading="lazy" decoding="async" />
                        )}
                        <div className="min-w-0">
                          <span className="font-bold text-neutral-800 truncate text-sm block">{item.name}</span>
                          {/* ประเภท is still searched + sorted on, just not drawn —
                              the หมดแล้ว / ใกล้หมด pill sits in its place so the
                              name keeps the full width of the row. */}
                          {(isOut || isLow) && (
                            <span className={`inline-flex items-center gap-1 mt-0.5 text-[9px] px-2 py-0.5 rounded-full font-bold ${isOut ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-800'}`}>
                              <AlertTriangle className="w-3 h-3" />
                              <span>{isOut ? 'หมดแล้ว' : 'ใกล้หมด'}</span>
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <div className="font-mono text-right">
                          <span className={`text-base font-extrabold block ${isOut ? 'text-red-600' : isLow ? 'text-yellow-600' : 'text-neutral-800'}`}>
                            {item.quantity}
                          </span>
                          <span className="text-[9px] text-neutral-400">หน่วยคงเหลือ</span>
                        </div>

                        {/* Per-item quantity controls, one row: + · +1 · -1 — equal
                            squares so they stay compact and leave the name its
                            width (persists to stock_items)

                            The + square is near-black by day; at night that
                            reads as a hole in the card, so it flips to amber
                            with dark glyph. Written as a dark: override on this
                            button alone rather than the shared --c-ctl token,
                            so no other solid button moves. */}
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => askAddAmount(item)}
                            className="w-8 h-8 flex items-center justify-center bg-neutral-900 hover:bg-black text-white dark:bg-[#E5A63F] dark:hover:bg-[#D2932C] dark:text-[#1A120B] font-bold rounded-lg text-sm leading-none transition"
                            title="กรอกจำนวนที่ต้องการเพิ่ม"
                          >
                            +
                          </button>
                          <button
                            onClick={() => adjustStockItemQty(item.id, 1)}
                            className="w-8 h-8 flex items-center justify-center bg-green-500 hover:bg-green-600 text-white font-bold rounded-lg text-[11px] leading-none transition"
                          >
                            +1
                          </button>
                          <button
                            onClick={() => askRemoveReason(item, 1)}
                            disabled={item.quantity <= 0}
                            className="w-8 h-8 flex items-center justify-center bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg text-[11px] leading-none transition disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            -1
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    <div className="space-y-4 font-thai text-sm">

      {/* CHECK-BILL ALERT — stays on screen (on every tab) for as long as a table
          is waiting to be billed, so the toast+chime is never the only warning.
          Tapping it jumps to the board where พิมพ์บิล lives. */}
      {checkoutRequests.length > 0 && (
        <button
          onClick={() => setSubTab('orders')}
          className="w-full flex items-center gap-2.5 bg-amber-100 border border-amber-300 text-amber-900 rounded-2xl px-3.5 py-2.5 text-left transition hover:bg-amber-200 active:scale-[0.99] animate-pulse-slow"
        >
          <Bell className="w-4 h-4 shrink-0" />
          <span className="text-xs font-bold flex-1">
            {checkoutRequests.map((o) => tableLabel(o.table)).join(', ')} ขอเช็กบิล
            <span className="block text-[10px] font-semibold text-amber-800/80">
              แตะเพื่อไปพิมพ์บิลที่หน้าบอร์ด
            </span>
          </span>
          <span className="bg-amber-600 text-white text-[11px] font-extrabold rounded-full px-2 py-0.5 font-mono shrink-0">
            {checkoutRequests.length}
          </span>
        </button>
      )}

      {/* STOCK CUTS WAITING TO BE SENT — the คลัง count is behind the tables
          until these go through, so it stays on screen rather than a toast. */}
      {pendingCuts > 0 && (
        <button
          onClick={() => retryStockCuts()}
          className="w-full flex items-center gap-2.5 bg-red-50 border border-red-200 text-red-800 rounded-2xl px-3.5 py-2.5 text-left transition hover:bg-red-100 active:scale-[0.99]"
        >
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span className="text-xs font-bold flex-1">
            ตัดสต็อกค้าง {pendingCuts} รายการ — ยอดในคลังยังไม่อัปเดต
            <span className="block text-[10px] font-semibold text-red-700/80">
              ระบบลองส่งใหม่อัตโนมัติ · แตะเพื่อลองตอนนี้
            </span>
          </span>
        </button>
      )}

      {/* HORIZONTAL TAB CONTROL */}
      <div className="flex gap-1 bg-neutral-100 rounded-xl p-1 text-[9px] font-bold">
        {/* Ordered the way a shift runs: read the board, take an order, cook it,
            then the one thing touched occasionally (คลัง). */}
        {[
          { id: 'orders', label: 'บอร์ด', icon: ClipboardList },
          { id: 'take-order', label: 'รับออเดอร์', icon: PlusCircle },
          { id: 'kitchen', label: 'ครัว', icon: ChefHat },
          { id: 'stock', label: 'คลัง', icon: Package },
        ].map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              className={`flex-1 py-2 rounded-lg flex flex-col items-center justify-center gap-1.5 transition ${tab.id === subTab ? 'bg-admin-field text-neutral-800 shadow-xs' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* PRIMARY SUB-TAB RENDER VIEW */}
      {renderActiveSubTab()}

      {/* ประวัติการบันทึกสต็อก — audit trail of every stock movement */}
      {showStockHistory && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[120] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-lg w-full max-h-[85vh] flex flex-col animate-slide-up text-neutral-800 shadow-2xl border-t border-neutral-100">
            <div className="flex items-center justify-between gap-3 p-5 border-b border-neutral-100">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-9 h-9 rounded-xl bg-sky-50 border border-sky-200 text-sky-700 flex items-center justify-center shrink-0">
                  <Clock className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-base font-extrabold font-kanit leading-tight">ประวัติการบันทึกสต็อก</h3>
                  <p className="text-[11px] text-neutral-500 font-medium">ใครปรับสต็อกรายการไหน เมื่อไหร่</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={reloadStockHistory}
                  className="p-2 rounded-lg hover:bg-neutral-100 text-neutral-500"
                  title="รีเฟรช"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowStockHistory(false)}
                  className="p-2 rounded-lg hover:bg-neutral-100 text-neutral-500"
                  title="ปิด"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="px-4 pt-3">
              <StockHistoryDateBar date={historyDate} onChange={setHistoryDate} />
            </div>

            <div className="overflow-y-auto p-4 space-y-2">
              {historyLoading && (
                <div className="p-6 text-center text-xs text-neutral-400 font-thai">กำลังโหลดประวัติ…</div>
              )}
              {historyError && !historyLoading && (
                <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-2xl text-xs font-thai flex items-center justify-between gap-3">
                  <span>{historyError}</span>
                  <button onClick={reloadStockHistory} className="font-bold underline shrink-0">ลองใหม่</button>
                </div>
              )}
              {!historyLoading && !historyError && stockHistory.length === 0 && (
                <div className="p-6 text-center text-xs text-neutral-400 font-thai">ไม่มีการบันทึกสต็อกในวันที่เลือก</div>
              )}
              {!historyLoading && !historyError && stockHistory.length >= STOCK_HISTORY_DAY_LIMIT && (
                <p className="text-[10px] text-neutral-400 text-center font-thai">แสดง {STOCK_HISTORY_DAY_LIMIT} รายการล่าสุดของวันที่เลือกเท่านั้น</p>
              )}
              {!historyLoading && !historyError && stockHistory.map((h) => (
                <div key={h.id} className="flex items-start gap-3 p-3 bg-admin-field rounded-2xl text-xs font-thai">
                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0 mt-0.5 ${STOCK_ACTION_COLORS[h.action] || 'bg-neutral-100 text-neutral-600'}`}>
                    {STOCK_ACTION_LABELS[h.action] || h.action}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-neutral-800 truncate">{h.itemName || '—'}</p>
                    {h.note && (
                      <p className="text-[10px] text-red-500 font-medium truncate">📝 {h.note}</p>
                    )}
                    <p className="text-[10px] text-neutral-400 font-medium">
                      โดย {h.byName || h.byUser || 'ไม่ทราบ'} · {fmtStockTime(h.createdAt)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    {h.delta !== 0 && (
                      <span className={`font-mono font-extrabold ${h.delta > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {h.delta > 0 ? `+${h.delta}` : h.delta}
                      </span>
                    )}
                    {h.quantityAfter != null && (
                      <p className="text-[10px] text-neutral-400 font-medium">เหลือ {h.quantityAfter}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ADD-STOCK AMOUNT — the black กรอกเลข button: type how many units to add.
          The box filters to digits as you type, so only จำนวนเต็มบวก can be sent. */}
      {addTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[120] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 shadow-2xl border-t border-neutral-100">
            <div className="flex items-start gap-3">
              {/* bg-ctl, not bg-neutral-900: the night theme inverts the grey
                  ramp, so neutral-900 turns near-WHITE there and a white glyph
                  on top disappears. The ctl token is the one that flips to
                  amber-on-dark instead (see tailwind.config.js). */}
              <span className="w-10 h-10 rounded-xl bg-ctl text-ctl-ink flex items-center justify-center shrink-0">
                <Plus className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-extrabold font-kanit leading-tight">เพิ่มสต็อก</h3>
                <p className="text-[11px] text-neutral-500 font-medium font-thai">
                  {addTarget.name} — คงเหลือตอนนี้ {addTarget.quantity} หน่วย
                </p>
              </div>
            </div>

            <input
              type="text"
              inputMode="numeric"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
              placeholder="กรอกจำนวนเต็มบวก เช่น 24"
              autoFocus
              className="w-full border rounded-xl py-2.5 px-3 bg-admin-field text-sm font-bold text-center focus:outline-none focus:ring-1 focus:ring-amber-500 font-thai"
            />

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setAddTarget(null)}
                className="flex-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-bold py-2.5 rounded-xl text-sm transition"
              >
                ยกเลิก
              </button>
              <button
                onClick={confirmAdd}
                disabled={!(Number.parseInt(addInput, 10) > 0)}
                className="flex-1 bg-ctl hover:bg-ctl-hover text-white font-bold py-2.5 rounded-xl text-sm transition disabled:opacity-90 disabled:cursor-not-allowed"
              >
                ยืนยันเพิ่ม
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REMOVE-STOCK REASON — why units are being taken out (เจ้าของดื่มเอง …) */}
      {removeTarget && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[120] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 shadow-2xl border-t border-neutral-100">
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 text-red-700 flex items-center justify-center shrink-0">
                <Minus className="w-5 h-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-extrabold font-kanit leading-tight">นำสต็อกออก {removeTarget.amount} หน่วย</h3>
                <p className="text-[11px] text-neutral-500 font-medium">
                  {removeTarget.item.name} — ระบุเหตุผลที่ของหายไป
                </p>
              </div>
            </div>

            {/* Quick-pick reasons */}
            <div className="flex flex-wrap gap-2">
              {REMOVE_REASONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setRemoveReason(r)}
                  className={`text-[11px] font-bold px-3 py-1.5 rounded-full border transition ${removeReason === r ? 'bg-amber-600 text-white border-amber-600' : 'bg-admin-field text-neutral-600 border-neutral-200 hover:bg-neutral-100'}`}
                >
                  {r}
                </button>
              ))}
            </div>

            <input
              type="text"
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmRemove(); }}
              placeholder="หรือพิมพ์เหตุผลเอง เช่น เจ้าของดื่มเอง"
              autoFocus
              className="w-full border rounded-xl py-2.5 px-3 bg-admin-field text-sm font-medium focus:outline-none focus:ring-1 focus:ring-amber-500 font-thai"
            />

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setRemoveTarget(null)}
                className="flex-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-bold py-2.5 rounded-xl text-sm transition"
              >
                ยกเลิก
              </button>
              <button
                onClick={confirmRemove}
                disabled={!removeReason.trim()}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2.5 rounded-xl text-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ยืนยันนำออก
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ITEM DETAIL MODAL (add-ons + notes + qty) — same options as customer */}
      {selectedItem && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 max-h-[85vh] overflow-y-auto shadow-2xl border-t border-neutral-100">

            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-base font-extrabold font-kanit">{selectedItem.name}</h3>
                <span className="text-amber-600 font-extrabold font-mono text-base block mt-0.5">฿{selectedOption ? selectedOption.price : selectedItem.price}</span>
                <span className="text-[10px] text-neutral-400 font-medium">
                  {detailMode === 'editbill' ? `เพิ่มลงบิล ${tableLabel(editingBill?.table)}` : `รับออเดอร์ ${tableLabel(targetTable)}`}
                </span>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {selectedItem.desc && (
              <p className="text-xs text-neutral-400 bg-neutral-50 p-2.5 rounded-xl leading-normal font-medium font-thai">
                {selectedItem.desc}
              </p>
            )}

            {/* PROTEIN / SIZE (เนื้อสัตว์) — one required pick, mirrors the customer
                dialog. Absent for dishes sold at a single price. */}
            {selectedItem.options && selectedItem.options.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400">
                  {selectedItem.options.every(o => ['M', 'L', 'S'].includes(o.name)) ? 'เลือกขนาด' : 'เลือกเนื้อสัตว์'}
                </h4>
                <div className="grid grid-cols-2 gap-1.5">
                  {selectedItem.options.map(opt => (
                    <label
                      key={opt.name}
                      className={`flex items-center justify-between p-2.5 border rounded-xl cursor-pointer transition text-xs font-thai ${selectedOption?.name === opt.name ? 'border-amber-500 bg-amber-500/10 ring-1 ring-amber-500' : 'border-neutral-150 hover:bg-neutral-50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="staff-option-choice"
                          checked={selectedOption?.name === opt.name}
                          onChange={() => setSelectedOption(opt)}
                          className="w-4 h-4 text-amber-600 border-neutral-300 focus:ring-amber-500"
                        />
                        <span className="font-semibold text-neutral-700">{opt.name}</span>
                      </div>
                      <span className="text-neutral-500 font-bold font-mono">฿{opt.price}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* PICK-ONE GROUPS — ขนาด / ระดับความหวาน, straight from the sheet */}
            {selectedExtras.choices.map(group => (
              <div key={group.id || group.name} className="space-y-2">
                <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400">
                  {group.name}
                </h4>
                <div className="grid grid-cols-2 gap-1.5">
                  {group.options.map(opt => (
                    <label
                      key={opt.name}
                      className={`flex items-center justify-between p-2.5 border rounded-xl cursor-pointer transition text-xs font-thai ${selectedChoices[group.name]?.name === opt.name ? 'border-amber-500 bg-amber-500/10 ring-1 ring-amber-500' : 'border-neutral-150 hover:bg-neutral-50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`staff-choice-${group.name}`}
                          checked={selectedChoices[group.name]?.name === opt.name}
                          onChange={() => handleChoiceChange(group.name, opt)}
                          className="w-4 h-4 text-amber-600 border-neutral-300 focus:ring-amber-500"
                        />
                        <span className="font-semibold text-neutral-700">{opt.name}</span>
                      </div>
                      {opt.price > 0 && (
                        <span className="text-neutral-500 font-bold font-mono">+฿{opt.price}</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            ))}

            {/* ADDONS LIST */}
            {selectedExtras.addons.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400">ตัวเลือกเพิ่มเติม</h4>
                <div className="space-y-1.5">
                  {selectedExtras.addons.map(addon => (
                    <label
                      key={addon.id}
                      className="flex items-center justify-between p-2.5 border rounded-xl cursor-pointer hover:bg-neutral-50 transition text-xs font-thai border-neutral-150"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedAddons.some(a => a.name === addon.name)}
                          onChange={(e) => handleAddonChange(addon.name, addon.price, e.target.checked)}
                          className="w-4 h-4 text-amber-600 border-neutral-300 rounded focus:ring-amber-500"
                        />
                        <span className="font-semibold text-neutral-700">{addon.name}</span>
                      </div>
                      <span className="text-neutral-500 font-bold font-mono">+฿{addon.price}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* CUSTOM NOTES */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">หมายเหตุเพิ่มเติมถึงครัว</label>
              <textarea
                value={modalNotes}
                onChange={e => setModalNotes(e.target.value)}
                placeholder="เช่น ขอเผ็ดน้อยมาก, ไม่ใส่ผักชี, หรืออื่นๆ..."
                className="w-full text-xs border border-neutral-200 rounded-xl p-3 focus:outline-none focus:ring-2 focus:ring-amber-500 h-16 resize-none"
              />
            </div>

            {/* QUANTITY & ACTIONS */}
            <div className="flex items-center justify-between gap-4 pt-3 border-t border-neutral-100">
              <div className="flex items-center gap-3.5 border border-neutral-200 rounded-xl px-3 py-1.5">
                <button
                  onClick={() => setModalQty(prev => Math.max(1, prev - 1))}
                  className="p-1 text-neutral-500 hover:bg-neutral-100 rounded-lg transition"
                >
                  <Minus className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
                <span className="font-mono font-extrabold text-sm w-5 text-center">{modalQty}</span>
                <button
                  onClick={() => setModalQty(prev => prev + 1)}
                  className="p-1 text-neutral-500 hover:bg-neutral-100 rounded-lg transition"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
              </div>

              <button
                onClick={handleAddToCart}
                className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition text-center text-xs"
              >
                {detailMode === 'editbill' ? 'เพิ่มลงบิล' : 'ใส่บิล'} (฿{(((selectedOption ? selectedOption.price : selectedItem.price) + selectedAddons.reduce((sum, a) => sum + a.price, 0) + choicesCost(selectedChoices)) * modalQty).toLocaleString()})
              </button>
            </div>

          </div>
        </div>
      )}

      {/* CUSTOM ITEM MODAL ("เมนูอื่นๆ") — staff-typed item + editable extras */}
      {showCustomModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 max-h-[85vh] overflow-y-auto shadow-2xl border-t border-neutral-100">

            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-base font-extrabold font-kanit">เมนูอื่นๆ (คีย์เอง)</h3>
                <span className="text-[10px] text-neutral-400 font-medium">รับออเดอร์ {tableLabel(targetTable)}</span>
              </div>
              <button
                onClick={() => setShowCustomModal(false)}
                className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* NAME (required) */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">ชื่อเมนู <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                placeholder="เช่น ข้าวไข่ข้น, น้ำเปล่าพิเศษ..."
                className="w-full text-xs border border-neutral-200 rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>

            {/* PRICE (required, > 0) */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">ราคา/ชิ้น (บาท) <span className="text-red-500">*</span></label>
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={customPrice}
                onChange={e => setCustomPrice(e.target.value)}
                placeholder="0"
                className="w-full text-xs border border-neutral-200 rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono font-bold"
              />
            </div>

            {/* EXTRAS — toggle chips with editable prices */}
            <div className="space-y-2">
              <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400">ตัวเลือกเพิ่มเติม (กดเลือก)</h4>
              <div className="space-y-1.5">
                {Object.entries(customExtras).map(([name, v]) => (
                  <div
                    key={name}
                    className={`flex items-center justify-between gap-2 p-2.5 border rounded-xl transition text-xs font-thai ${v.on ? 'border-amber-500 bg-amber-500/10 ring-1 ring-amber-500' : 'border-neutral-150'}`}
                  >
                    <button
                      onClick={() => toggleCustomExtra(name)}
                      className="flex items-center gap-2 flex-1 text-left"
                    >
                      <span className={`w-4 h-4 rounded flex items-center justify-center border ${v.on ? 'bg-amber-600 border-amber-600 text-white' : 'border-neutral-300 bg-admin-card'}`}>
                        {v.on && <Check className="w-3 h-3 stroke-[3]" />}
                      </span>
                      <span className="font-semibold text-neutral-700">{name}</span>
                    </button>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-neutral-400 font-bold">+฿</span>
                      <input
                        type="number"
                        min="0"
                        value={v.price}
                        onChange={e => setCustomExtraPrice(name, e.target.value)}
                        className="w-16 text-xs border border-neutral-200 rounded-lg p-1.5 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono font-bold text-right"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* TAKEAWAY toggle */}
            <button
              onClick={() => setCustomTakeaway(prev => !prev)}
              className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-xs transition border ${customTakeaway ? 'bg-amber-600 border-amber-600 text-white' : 'bg-admin-card border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
            >
              <span>🏠</span>
              <span>{customTakeaway ? 'กลับบ้าน (เปิดอยู่)' : 'กลับบ้าน'}</span>
            </button>

            {/* NOTES */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">หมายเหตุเพิ่มเติมถึงครัว</label>
              <textarea
                value={customNote}
                onChange={e => setCustomNote(e.target.value)}
                placeholder="เช่น ขอเผ็ดน้อย, ไม่ใส่ผักชี, หรืออื่นๆ..."
                className="w-full text-xs border border-neutral-200 rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 h-16 resize-none"
              />
            </div>

            {/* QUANTITY & CONFIRM */}
            <div className="flex items-center justify-between gap-4 pt-3 border-t border-neutral-100">
              <div className="flex items-center gap-3.5 border border-neutral-200 rounded-xl px-3 py-1.5">
                <button
                  onClick={() => setCustomQty(prev => Math.max(1, prev - 1))}
                  className="p-1 text-neutral-500 hover:bg-neutral-100 rounded-lg transition"
                >
                  <Minus className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
                <span className="font-mono font-extrabold text-sm w-5 text-center">{customQty}</span>
                <button
                  onClick={() => setCustomQty(prev => prev + 1)}
                  className="p-1 text-neutral-500 hover:bg-neutral-100 rounded-lg transition"
                >
                  <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
              </div>

              <button
                onClick={handleAddCustomToCart}
                disabled={!customValid}
                className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl transition text-center text-xs"
              >
                ใส่บิล (฿{customLiveTotal.toLocaleString()})
              </button>
            </div>

          </div>
        </div>
      )}

      {/* EDIT BILL MODAL (For modifying active bills) */}
      {editingBill && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 max-h-[85vh] overflow-y-auto shadow-2xl border-t border-neutral-100">
            
            <div className="flex justify-between items-center gap-2">
              <h3 className="text-base font-extrabold font-kanit flex items-center gap-1.5 text-neutral-800 min-w-0">
                <Edit className="text-amber-600 w-4 h-4 shrink-0" />
                <span className="truncate">แก้ไขรายการบิล {tableLabel(editingBill.table)}</span>
              </h3>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => { setMoveConflict(''); setShowMovePicker((open) => !open); }}
                  className={`flex items-center gap-1 font-bold px-2.5 py-1.5 rounded-lg text-[11px] transition ${showMovePicker ? 'bg-sky-600 text-white' : 'bg-sky-100 hover:bg-sky-200 text-sky-700 border border-sky-200'}`}
                  title="ย้ายบิลนี้ไปโต๊ะอื่น"
                >
                  <MapPin className="w-3.5 h-3.5" />
                  <span>ย้ายโต๊ะ</span>
                </button>
                <button
                  onClick={() => { setShowMovePicker(false); setMoveConflict(''); setEditingBill(null); }}
                  className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>
            </div>

            {/* ย้ายโต๊ะ PICKER — opens under the heading rather than as a second
                modal on top of this one. Only seated tables are offered: Grab /
                กลับบ้าน are delivery channels, not places to sit. */}
            {showMovePicker && (
              <div className="bg-sky-50 border border-sky-200 rounded-2xl p-3 space-y-2 text-xs font-thai">
                <span className="text-[10px] font-extrabold uppercase tracking-wider text-sky-700 block">
                  ย้ายบิลนี้จาก {tableLabel(editingBill.table)} ไปที่
                </span>
                <div className="grid grid-cols-5 gap-1.5 max-h-32 overflow-y-auto">
                  {Array.from({ length: settings.tables }, (_, i) => String(i + 1))
                    .filter((n) => n !== String(editingBill.table))
                    .map((n) => {
                      const busy = orders.some((o) =>
                        String(o.table) === n && o.status !== 'paid' && o.status !== 'cancelled'
                      );
                      return (
                        <button
                          key={n}
                          onClick={() => handleMoveTable(n)}
                          // A table with an open bill is still selectable — it
                          // just asks รวม/แยก first — but marked, so staff can
                          // see at a glance which ones are free.
                          className={`py-2 rounded-lg font-extrabold font-mono transition border ${moveConflict === n
                            ? 'bg-sky-600 border-sky-600 text-white'
                            : busy
                              ? 'bg-amber-100 border-amber-300 text-amber-800 hover:bg-amber-200'
                              : 'bg-admin-card border-sky-200 text-neutral-700 hover:bg-sky-100'}`}
                          title={busy ? `โต๊ะ ${n} — มีบิลเปิดอยู่` : `โต๊ะ ${n} — ว่าง`}
                        >
                          {n}
                        </button>
                      );
                    })}
                </div>

                {/* รวมบิล / แยกบิล — asked only when the chosen table already has
                    an open bill. Two groups pushing tables together and paying as
                    one is the common case, so it leads. */}
                {moveConflict ? (
                  <div className="bg-admin-card border border-sky-300 rounded-xl p-2.5 space-y-2">
                    <p className="text-[11px] font-bold text-neutral-700">
                      โต๊ะ {moveConflict} มีบิลเปิดอยู่แล้ว ({openBillsAt(moveConflict).length} บิล) ต้องการแบบไหน?
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        onClick={() => mergeBillInto(moveConflict)}
                        className="bg-sky-600 hover:bg-sky-700 text-white font-bold py-2 rounded-lg text-[11px] transition"
                      >
                        รวมเป็นบิลเดียว
                      </button>
                      <button
                        onClick={() => moveBillTo(moveConflict)}
                        className="bg-admin-field hover:bg-neutral-100 border text-neutral-700 font-bold py-2 rounded-lg text-[11px] transition"
                      >
                        ย้ายแบบแยกบิล
                      </button>
                    </div>
                    <button
                      onClick={() => setMoveConflict('')}
                      className="w-full text-[10px] text-neutral-500 hover:text-neutral-700 font-bold py-1"
                    >
                      เลือกโต๊ะอื่น
                    </button>
                    <p className="text-[10px] text-neutral-400 leading-normal">
                      รวมบิล = รายการอาหารทั้งหมดไปอยู่ในบิลเดียว จ่ายทีเดียวจบ (ใช้เลขที่บิลของโต๊ะปลายทาง)
                    </p>
                  </div>
                ) : (
                  <p className="text-[10px] text-sky-700/80">
                    สีเหลือง = โต๊ะนั้นมีบิลที่ยังไม่ชำระอยู่ (กดแล้วจะถามว่ารวมบิลไหม) · เมื่อย้ายแล้ว หน้าจอของลูกค้าที่โต๊ะเดิมจะเปลี่ยนเป็นเลขโต๊ะใหม่ให้เอง
                  </p>
                )}
              </div>
            )}

            {/* EDIT BILL ITEMS */}
            <div className="divide-y divide-neutral-100 max-h-56 overflow-y-auto">
              {editingBill.items.length > 0 ? (
                editingBill.items.map((item, index) => (
                  <div key={index} className="py-3 flex justify-between items-center text-xs font-thai">
                    <div className="space-y-0.5 max-w-[50%]">
                      <span className={`font-extrabold block truncate ${isDiscountItem(item) ? 'text-rose-700' : 'text-neutral-800'}`}>
                        {item.name}
                      </span>
                      {isDiscountItem(item) ? (
                        <span className="text-neutral-400">ส่วนลดท้ายบิล{item.by ? ` · โดย ${item.by}` : ''}</span>
                      ) : (
                        <span className="text-neutral-400 font-mono">฿{item.price + (item.addonCost || 0)} / ชิ้น</span>
                      )}
                      {item.addOns && item.addOns.length > 0 && (
                        <p className="text-[9px] text-neutral-400 truncate">พิเศษ: {item.addOns.join(', ')}</p>
                      )}
                      {item.note && (
                        <p className="text-[9px] text-red-500 italic truncate">📝 {item.note}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      {/* A ส่วนลด line has no quantity to step — doubling it
                          would silently double the money off. It can still be
                          removed here, or changed from the ส่วนลด button. */}
                      {isDiscountItem(item) ? (
                        <span className="font-bold font-mono text-rose-600">
                          -฿{Math.abs(item.price).toLocaleString()}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2 border rounded-lg px-2 py-0.5 bg-neutral-50">
                          <button
                            onClick={() => handleEditBillQty(index, -1)}
                            className="p-0.5 hover:bg-neutral-200 rounded text-neutral-500"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="font-bold w-4 text-center font-mono">{item.qty}</span>
                          <button
                            onClick={() => handleEditBillQty(index, 1)}
                            className="p-0.5 hover:bg-neutral-200 rounded text-neutral-500"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                      <button 
                        onClick={() => handleRemoveEditBillItem(index)}
                        className="text-red-500 hover:text-red-700 p-1 rounded-lg hover:bg-red-500/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-center text-xs py-6 text-neutral-400 italic">ไม่มีรายการเหลืออยู่ในบิลนี้ (หากกดบันทึก บิลจะถูกยกเลิก)</p>
              )}
            </div>

            {/* APPEND NEW ITEM TO PENDING BILL */}
            <div className="space-y-1.5 pt-3 border-t border-neutral-100">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">เพิ่มรายการสินค้าลงในโต๊ะนี้</label>
              <div className="flex gap-2">
                <select 
                  value={editAddMenuId}
                  onChange={e => setEditAddMenuId(e.target.value)}
                  className="flex-1 bg-admin-field border border-neutral-200 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
                >
                  <option value="">-- เลือกเมนูอาหารที่จะสั่งเพิ่ม --</option>
                  {/* Grouped by shift, and covering BOTH menus: a table sitting
                      through the 17:00 changeover can still add the dish it
                      ordered an hour ago. The heading is what tells ฿50 ข้าวผัด
                      apart from ฿70 ข้าวผัด. */}
                  {['day', 'night', 'both'].map(shift => {
                    const items = orderableMenu.filter(m => m.available && m.theme === shift);
                    if (!items.length) return null;
                    return (
                      <optgroup key={shift} label={`เมนู${SHIFT_LABELS[shift]}`}>
                        {items.map(m => (
                          <option key={m.id} value={m.id}>{m.name} (฿{m.price})</option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
                <button 
                  onClick={handleAddItemToEditBill}
                  className="bg-ctl hover:bg-ctl-hover text-ctl-ink text-xs font-bold px-4 py-2.5 rounded-xl transition"
                >
                  สั่งเพิ่ม
                </button>
              </div>
            </div>

            {/* SUMMARY & SUBMIT */}
            <div className="space-y-3 pt-3 border-t border-neutral-100">
              <div className="flex justify-between text-sm font-extrabold font-kanit">
                <span>ราคารวมหลังแก้ไข</span>
                <span className="text-amber-600 font-mono text-base">฿{editingBill.total.toLocaleString()}</span>
              </div>
              
              <div className="flex gap-2 pt-1 font-thai text-xs">
                <button 
                  onClick={() => setEditingBill(null)}
                  className="flex-1 bg-neutral-150 hover:bg-neutral-200 font-bold py-2.5 rounded-xl transition text-neutral-700"
                >
                  ยกเลิก
                </button>
                <button 
                  onClick={handleSaveEditedBill}
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white font-bold py-2.5 rounded-xl transition text-center"
                >
                  บันทึกการแก้ไขบิล
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ส่วนลด — pick a percentage OR a flat baht amount, see what it takes off,
          then sign for it. */}
      {discountFor && (() => {
        const order = orders.find(o => o.id === discountFor);
        // The bill could have been settled from another device while this was
        // open; there is nothing to discount then.
        if (!order || order.status === 'paid' || order.status === 'cancelled') {
          return null;
        }
        const isBaht = discountMode === 'baht';
        const value = Number(discountValue) || 0;
        const spec = { mode: discountMode, value };
        const base = discountBase(order.items);
        const amount = discountAmount(order.items, spec);
        const current = billDiscount(order);
        const valid = value >= 0 && (isBaht || value <= 100);
        // ฿500 typed onto a ฿300 bill is allowed, and takes ฿300 off — worth
        // saying so on screen rather than letting the number quietly disagree.
        const capped = isBaht && value > base && base > 0;
        // Quick picks, in the unit being typed. The baht row is the notes a till
        // actually holds.
        const quickPicks = isBaht ? [20, 50, 100, 200] : [5, 10, 15, 20];
        return (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-xs z-[250] flex items-center justify-center p-4 font-thai">
            <div className="bg-admin-card rounded-2xl w-full max-w-xs p-5 space-y-4 shadow-2xl text-neutral-800">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-600 flex items-center justify-center shrink-0">
                    <TicketPercent className="w-5 h-5" />
                  </span>
                  <div>
                    <h3 className="font-kanit font-extrabold text-sm leading-tight">ให้ส่วนลด</h3>
                    <p className="text-[11px] text-neutral-500">{tableLabel(order.table)} · {order.no}</p>
                  </div>
                </div>
                <button
                  onClick={() => setDiscountFor(null)}
                  className="p-1 -mr-1 -mt-1 rounded-lg text-neutral-400 hover:bg-neutral-100 transition"
                  aria-label="ปิด"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Which unit the number below is in. Switching clears the box:
                  "10" means two very different discounts on the two sides, and
                  carrying it across would hand out ฿10 where 10% was meant. */}
              <div className="flex gap-1 bg-neutral-100 rounded-xl p-1 text-[11px] font-bold">
                {[
                  { id: 'percent', label: 'ลดเป็น %' },
                  { id: 'baht', label: 'ลดเป็นบาท' },
                ].map(m => (
                  <button
                    key={m.id}
                    onClick={() => { setDiscountMode(m.id); setDiscountValue(''); }}
                    className={`flex-1 py-2 rounded-lg transition ${
                      discountMode === m.id
                        ? 'bg-admin-field text-rose-600 shadow-xs'
                        : 'text-neutral-500 hover:text-neutral-700'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-4 gap-1.5">
                {quickPicks.map(p => (
                  <button
                    key={p}
                    onClick={() => setDiscountValue(String(p))}
                    className={`py-2 rounded-xl font-bold text-xs transition border ${
                      value === p
                        ? 'bg-rose-600 border-rose-600 text-white'
                        : 'bg-admin-field border-neutral-200 text-neutral-600 hover:border-rose-300'
                    }`}
                  >
                    {isBaht ? `฿${p}` : `${p}%`}
                  </button>
                ))}
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">
                  {isBaht ? 'หรือกรอกจำนวนเงินเอง' : 'หรือกรอกเปอร์เซ็นต์เอง'}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    // A baht discount has no ceiling of its own — the bill is its
                    // ceiling, and discountAmount() applies that.
                    max={isBaht ? undefined : 100}
                    step={isBaht ? '1' : 'any'}
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder="0"
                    className="w-full border rounded-xl p-3 pr-9 bg-admin-field focus:outline-none focus:ring-2 focus:ring-rose-500 font-mono font-bold text-lg"
                  />
                  <span className="absolute right-3.5 top-1/2 -translate-y-1/2 font-bold text-neutral-400">
                    {isBaht ? '฿' : '%'}
                  </span>
                </div>
              </div>

              {/* What it actually comes to, before anyone signs for it. */}
              <div className="bg-admin-field border border-neutral-200 rounded-xl p-3 space-y-1 text-xs">
                <div className="flex justify-between text-neutral-500">
                  <span>ยอดก่อนลด</span>
                  <span className="font-mono font-bold">฿{base.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-rose-600 font-bold">
                  <span>ส่วนลด {discountLabel(spec) || '0%'}</span>
                  <span className="font-mono">-฿{amount.toLocaleString()}</span>
                </div>
                <div className="flex justify-between border-t border-neutral-200 pt-1 font-extrabold">
                  <span>ยอดสุทธิ</span>
                  <span className="font-mono">฿{(base - amount).toLocaleString()}</span>
                </div>
                {capped ? (
                  <p className="text-[10px] text-amber-700 pt-0.5 font-bold">
                    ส่วนลดมากกว่ายอดบิล — ลดได้สูงสุด ฿{base.toLocaleString()}
                  </p>
                ) : (
                  <p className="text-[10px] text-neutral-400 pt-0.5">ปัดเศษเป็นจำนวนเต็มบาท</p>
                )}
              </div>

              <div className="space-y-2 text-xs">
                <button
                  onClick={() => confirmDiscount(order, spec)}
                  disabled={!valid || value === 0}
                  className="w-full bg-rose-600 hover:bg-rose-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-bold py-2.5 rounded-xl transition"
                >
                  ยืนยัน (ใส่ไอดีพนักงานต่อไป)
                </button>
                {/* Only offered when there IS one — otherwise it is a button that
                    asks for a PIN to change nothing. */}
                {current && (
                  <button
                    onClick={() => confirmDiscount(order, { mode: discountSpec(current).mode, value: 0 })}
                    className="w-full border border-neutral-200 hover:bg-neutral-50 text-neutral-600 font-bold py-2.5 rounded-xl transition"
                  >
                    นำส่วนลด {discountLabel(discountSpec(current))} ออกจากบิล
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ใส่ไอดีพนักงาน — sits above every other layer, because the actions it
          guards (พิมพ์บิล / ส่วนลด) are started from inside modals of their own. */}
      {pinAction && (
        <PinGate
          title={pinAction.title}
          detail={pinAction.detail}
          confirmLabel={pinAction.confirmLabel}
          onCancel={() => setPinAction(null)}
          onVerified={(person) => {
            // Close first: `run` may open the print overlay or a toast, and the
            // dialog must not still be sitting on top of it.
            setPinAction(null);
            pinAction.run(person);
          }}
        />
      )}

      {/* HIDDEN PRINT SLIP — never shown on screen (off-canvas), only revealed
          to the printer by the @media print rule in index.css. printBill() fills
          this in and window.print() fires automatically, so there is no preview
          screen: staff tap พิมพ์บิล and the XP-80T just prints. Styled plain
          (no colour/shadow/rounded borders) for an 80mm monochrome thermal roll.

          Portalled to <body> rather than left here inside the app tree: the
          print stylesheet hides every child of <body> EXCEPT this one, which is
          the only way of collapsing the app that phones render correctly (see
          the @media print block in index.css). */}
      {printData && createPortal(
        <div id="bill-print" aria-hidden="true">
          <div className="bp-hr-eq" />

          {/* Shop header */}
          <div className="bp-center">
            <div className="bp-shop">
              {theme === 'night' ? (settings.nameNight || 'เรือนเก่า') : (settings.name || 'ชื่อร้าน')}
            </div>
            <div className="bp-doc">ใบแจ้งรายการ{printData.type === 'split' ? ' (ไทยช่วยไทย)' : ''}</div>
          </div>

          <div className="bp-hr-eq" />

          {/* Table / time / date / staff */}
          <div className="bp-meta">
            <div>
              <span>โต๊ะ: {printData.table}</span>
              <span>เวลา: {new Date(printData.printedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.</span>
            </div>
            <div>
              <span>วันที่: {new Date(printData.printedAt).toLocaleDateString('en-GB')}</span>
              <span>พนักงาน: {printData.staff}</span>
            </div>
          </div>

          <div className="bp-hr-dash" />

          {/* Column header */}
          <div className="bp-item bp-head">
            <span className="bp-name">รายการ</span>
            <span className="bp-qty">Qty</span>
            <span className="bp-amt">ราคา</span>
          </div>

          {/* Line items — base on its own line, add-ons broken out beneath it */}
          {printData.items.map((it, i) => {
            const base = (it.price || 0) * it.qty;
            const addon = (it.addonCost || 0) * it.qty;
            // A discount prints as a plain deduction: no "x1" quantity, since it
            // is one adjustment to the bill rather than one of something.
            if (isDiscountItem(it)) {
              return (
                <div className="bp-item" key={i}>
                  <span className="bp-name">{it.name}</span>
                  <span className="bp-qty" />
                  <span className="bp-amt">-{fmtBaht(Math.abs(base))}</span>
                </div>
              );
            }
            return (
              <React.Fragment key={i}>
                <div className="bp-item">
                  <span className="bp-name">{it.name}</span>
                  <span className="bp-qty">x{it.qty}</span>
                  <span className="bp-amt">{fmtBaht(base)}</span>
                </div>
                {addon > 0 && (
                  <div className="bp-item bp-sub-item">
                    <span className="bp-name">- {it.addOns && it.addOns.length ? it.addOns.join(', ') : 'พิเศษ'}</span>
                    <span className="bp-qty">x{it.qty}</span>
                    <span className="bp-amt">{fmtBaht(addon)}</span>
                  </div>
                )}
              </React.Fragment>
            );
          })}

          <div className="bp-hr-dash" />

          {/* Total */}
          <div className="bp-total-row">
            <span>ราคารวมทั้งสิ้น (Total)</span>
            <span>{fmtBaht(printData.total)} THB</span>
          </div>

          <div className="bp-hr-eq" />

          {/* PromptPay QR of the shop account */}
          {settings.promptpayId && (
            <div className="bp-center bp-qr">
              <div className="bp-qrhead">[ QR CODE สแกนจ่าย ]</div>
              <QRCodeSVG value={generatePayload(settings.promptpayId, { amount: printData.total })} size={168} />
            </div>
          )}
          {printData.type === 'split' && (
            <div className="bp-center bp-foot">เปิดแอปถุงเงินบนมือถือร้าน แล้วให้ลูกค้าสแกน QR สิทธิ์ไทยช่วยไทย</div>
          )}

          {/* Footer */}
          <div className="bp-center bp-foot">
            <div>กรุณาตรวจสอบรายการอาหาร</div>
            <div>ขอบคุณที่ใช้บริการ</div>
          </div>

          <div className="bp-hr-eq" />
        </div>,
        document.body
      )}

    </div>
  );
}

export default StaffView;
