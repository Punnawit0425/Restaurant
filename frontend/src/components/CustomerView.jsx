import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ShoppingBag, ShoppingBasket, Trash2, X, Plus, Minus, CheckCircle, ArrowUp } from 'lucide-react';
import { isDrinkItem, extrasFor, defaultChoices, choicesCost } from '../menu-groups';
import { mergeOrder, itemRound, unservedItems, isDiscountItem, TAKEAWAY_TABLE } from '../orders';
import { shiftNow } from '../shift';
import { generateOrderNo } from '../invoice';
import { resolveImageUrl, fetchStockAvailability } from '../api';

// Normalise a name for stock↔menu matching: trim, collapse inner whitespace,
// lowercase. Thai has no case but this keeps mixed Thai/English names in step.
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
import foodDayImg from '../assets/food.jpg';
import foodNightImg from '../assets/food-night.png';
import beverageDayImg from '../assets/beverage.jpg';
import beverageNightImg from '../assets/beverage-night.jpg';

// Each storefront card carries one photo per theme: the daytime kitchen
// shoots bright, the bar shoots dark, so a single image for both would
// always look wrong in one of them.
const GROUPS = [
  {
    key: 'food',
    label: 'เมนูอาหาร',
    labelEn: 'Food',
    image: { day: foodDayImg, night: foodNightImg },
    fallback: 'from-[#A9713D] to-[#6B4021]',
  },
  {
    key: 'drink',
    label: 'เครื่องดื่ม',
    labelEn: 'Drinks',
    image: { day: beverageDayImg, night: beverageNightImg },
    fallback: 'from-[#C99A5B] to-[#8A5A32]',
  },
];

function CustomerView({
  theme,
  lang = 'th',
  tableNo,
  // สั่งกลับบ้าน: this phone's session id (App.jsx), or null at a table. When set
  // the phone's bill is found by session rather than by table number.
  takeawaySession = null,
  menu,
  orders,
  setOrders,
  stock,
  cart,
  setCart,
  addons,
  choices,
  addonPresets,
  showToast
}) {
  const [showStatusList, setShowStatusList] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  // What one dish offers: the owner's ตัวเลือกเสริม presets when they exist,
  // otherwise the shift-derived lists. See extrasFor in menu-groups.js.
  const extrasOf = (item) => extrasFor(addonPresets, addons, choices, theme, item);
  const selectedExtras = selectedItem ? extrasOf(selectedItem) : { addons: [], choices: [] };
  const [selectedOption, setSelectedOption] = useState(null); // chosen protein
  const [modalQty, setModalQty] = useState(1);
  const [modalNotes, setModalNotes] = useState('');
  const [selectedAddons, setSelectedAddons] = useState([]);
  // Pick-exactly-one groups, keyed by group name: { 'ขนาด': {name, price}, ... }
  const [selectedChoices, setSelectedChoices] = useState({});
  const [showCartModal, setShowCartModal] = useState(false);
  const [showSuccessNotice, setShowSuccessNotice] = useState(false);
  // เช็กบิลด้วยตัวเอง — when open, the diner picks ปกติ vs คนละครึ่ง.
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);

  // Show a "กลับขึ้นบนสุด" button once the diner has scrolled down, so they can
  // jump straight back to the food/drink tabs. We can't assume WHICH element
  // scrolls (the <main> wrapper on desktop, the window on some mobile browsers),
  // so we walk up from our own node to find the nearest scrollable ancestor and
  // fall back to the window. rootRef anchors that search.
  const rootRef = useRef(null);
  const scrollerRef = useRef(null);
  const [showTopBtn, setShowTopBtn] = useState(false);
  useEffect(() => {
    // Nearest ancestor that actually scrolls; null means "use the window".
    const findScroller = () => {
      let el = rootRef.current?.parentElement;
      while (el) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }
      return null;
    };
    const scroller = findScroller();
    scrollerRef.current = scroller;
    const target = scroller || window;
    const getTop = () => (scroller ? scroller.scrollTop : window.scrollY);
    const onScroll = () => setShowTopBtn(getTop() > 200);
    onScroll();
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
  }, []);
  const scrollToTop = () => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const isDay = theme === 'day';
  const isEn = lang === 'en';
  // Pick the English text when the menu is in English AND a translation exists;
  // otherwise fall back to Thai. Every menu string in this view goes through it.
  const t = (th, en) => (isEn && en ? en : th);

  // Live stock levels from the คลังวัตถุดิบ (stock_items) table. Public read, so
  // the customer tab can grey out a sold-out dish. Refreshed on mount and every
  // 45s (staff top-ups/deductions land within that window). Fails open: on any
  // error this stays empty and nothing gets hidden.
  const [stockLevels, setStockLevels] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = () => fetchStockAvailability()
      .then(items => { if (alive) setStockLevels(items); })
      .catch(() => {});
    load();
    const timer = setInterval(load, 45000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // Map of normalised name -> remaining quantity, merged from the drink `stock`
  // object and the stock_items table. When a name shows up in both, the smaller
  // count wins (safer). A dish is "sold out" when its name matches an entry here
  // whose quantity is 0 or less; unmatched dishes are unaffected.
  const soldOutNames = useMemo(() => {
    const qty = new Map();
    const put = (name, count) => {
      const key = normName(name);
      if (!key || typeof count !== 'number') return;
      qty.set(key, qty.has(key) ? Math.min(qty.get(key), count) : count);
    };
    Object.values(stock || {}).forEach(s => put(s.name, s.count));
    (stockLevels || []).forEach(s => put(s.name, s.quantity));
    const out = new Set();
    qty.forEach((count, key) => { if (count <= 0) out.add(key); });
    return out;
  }, [stock, stockLevels]);

  // A dish is orderable only if the owner marked it available AND its linked
  // stock (matched by name) has not run dry.
  const isAvailable = (dish) => dish.available && !soldOutNames.has(normName(dish.name));

  // Filter menu items for current theme
const filteredMenu = menu.filter(item => item.theme === theme || item.theme === 'both');

  // Group the dishes under their category heading, preserving the order the
  // categories first appear in the menu data.
  const sectionsOf = (items, group) => items.reduce((acc, item) => {
    const section = acc.find(s => s.category === item.category);
    if (section) section.items.push(item);
    else acc.push({ category: item.category, categoryEn: item.categoryEn, group, items: [item] });
    return acc;
  }, []);

  // ONE list, food first and drinks after it — not two tabs. The two cards at the
  // top used to switch between them, which hid half the menu behind a tap nobody
  // made; now they are shortcuts that scroll to their part of the same page, and
  // a customer who just keeps scrolling reaches the drinks on their own.
  const sections = [
    ...sectionsOf(filteredMenu.filter(item => !isDrinkItem(item)), 'food'),
    ...sectionsOf(filteredMenu.filter(item => isDrinkItem(item)), 'drink'),
  ];

  // The first section of each group carries the scroll anchor the card jumps to.
  const anchorFor = (group) => `menu-group-${group}`;
  const firstOfGroup = (group) => sections.find(s => s.group === group);
  const jumpToGroup = (group) => {
    document.getElementById(anchorFor(group))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // The line under a dish name: its protein/size choices, e.g. "หมู/ไก่/ทะเล".
  const subtitleOf = (dish) =>
    dish.options && dish.options.length
      ? dish.options.map(o => t(o.name, o.nameEn)).join('/')
      : dish.desc;

  // Cart operations
  const cartCount = cart.reduce((sum, item) => sum + item.qty, 0);
  const cartTotal = cart.reduce((sum, item) => sum + (item.price + item.addonCost) * item.qty, 0);

  const handleOpenDetail = (item) => {
    if (isSettling) return; // ordering is locked while the table checks out
    if (!isAvailable(item)) return;
    setSelectedItem(item);
    // Default to the first protein option (if the dish has any).
    setSelectedOption(item.options && item.options.length ? item.options[0] : null);
    setModalQty(1);
    setModalNotes('');
    setSelectedAddons([]);
    // Every pick-one group starts on the sheet's first option (ไซส์ M, 100%).
    setSelectedChoices(defaultChoices(extrasOf(item).choices));
  };

  const handleChoiceChange = (groupName, option) => {
    setSelectedChoices(prev => ({ ...prev, [groupName]: option }));
  };

  // Price of the dish once the protein choice is applied.
  const basePriceOf = (item, option) =>
    option ? option.price : (item ? item.price : 0);

  const handleAddonChange = (addon, isChecked) => {
    if (isChecked) {
      setSelectedAddons(prev => [...prev, { name: addon.name, nameEn: addon.nameEn, price: addon.price }]);
    } else {
      setSelectedAddons(prev => prev.filter(a => a.name !== addon.name));
    }
  };

  const handleAddToCart = () => {
    if (!selectedItem) return;

    // Choices (ไซส์ L +5) and addons (ไข่มุก +5) both ride on addonCost, so the
    // cart, the bill and the kitchen ticket need no changes to understand them.
    const addonCost =
      selectedAddons.reduce((sum, a) => sum + a.price, 0) + choicesCost(selectedChoices);
    const basePrice = basePriceOf(selectedItem, selectedOption);
    // Fold the chosen protein into the item name, e.g. "ทอดน้ำปลาราดข้าว (หมู)".
    // `name` stays Thai — it is what the kitchen ticket and the bill show. A
    // parallel `nameEn` carries the English so the diner's own cart can read in
    // their language without changing what staff see.
    const foldName = (base, optName) => (optName ? `${base} (${optName})` : base);
    const itemName = foldName(selectedItem.name, selectedOption?.name);
    const itemNameEn = foldName(
      t(selectedItem.name, selectedItem.nameEn),
      selectedOption ? t(selectedOption.name, selectedOption.nameEn) : null
    );
    const cartItem = {
      id: selectedItem.id + '_' + Date.now().toString(36),
      menuId: selectedItem.id,
      group: selectedItem.group || 'food',
      // Section heading rides along so the order line keeps its 2-state
      // (received -> served) lifecycle for serve-direct headings — cold towels,
      // desserts, snacks — the same way drinks do. See isServeDirectItem.
      category: selectedItem.category,
      name: itemName,
      nameEn: itemNameEn,
      option: selectedOption ? selectedOption.name : null,
      basePrice: basePrice,
      price: basePrice,
      addonCost: addonCost,
      qty: modalQty,
      addons: [
        ...Object.values(selectedChoices).map(o => o.name),
        ...selectedAddons.map(a => a.name),
      ],
      addonsEn: [
        ...Object.values(selectedChoices).map(o => t(o.name, o.nameEn)),
        ...selectedAddons.map(a => t(a.name, a.nameEn)),
      ],
      note: modalNotes,
      stockRef: selectedItem.stockRef || null
    };

    setCart(prev => [...prev, cartItem]);
    setSelectedItem(null);
    showToast(isEn ? `Added ${itemNameEn} to cart` : `เพิ่ม ${itemName} ลงตะกร้าแล้ว`);
  };

  const handleRemoveCartItem = (itemId) => {
    const updatedCart = cart.filter(item => item.id !== itemId);
    setCart(updatedCart);
    if (updatedCart.length === 0) {
      setShowCartModal(false);
    }
  };

  const handlePlaceOrder = () => {
    if (cart.length === 0) return;
    if (isSettling) {
      showToast(t('กำลังเช็กบิล หากต้องการสั่งเพิ่มกรุณาแจ้งพนักงาน', 'Checking out — please ask staff to order more'));
      return;
    }

    // REALTIME stock validation
    let stockError = false;
    let errorItemName = '';

    cart.forEach(cartItem => {
      if (cartItem.stockRef && stock[cartItem.stockRef]) {
        const remaining = stock[cartItem.stockRef].count;
        if (remaining < cartItem.qty) {
          stockError = true;
          errorItemName = cartItem.name;
        }
      }
    });

    if (stockError) {
      alert(`ขออภัยอย่างยิ่ง! เครื่องดื่ม [${errorItemName}] มีสต็อกไม่เพียงพอในขณะนี้ ไม่สามารถจัดส่งออเดอร์ได้`);
      return;
    }

    // Stock is NOT deducted here — it comes off only when staff mark each dish
    // เสิร์ฟแล้ว (สำเร็จ). We carry `stockRef` onto the order item so the serve
    // action knows what to subtract by the ordered qty.

    // Create new order/bill
    const orderNo = generateOrderNo(orders);
    const newOrder = {
      id: 'B' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      no: orderNo,
      time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
      createdAt: Date.now(),
      // The shop's clock decides the shift, not the menu this was ordered from:
      // a page left open on the day menu and submitted at 18:00 is still the
      // night shop's takings. (A second round joins the table's open bill and
      // keeps that bill's shift — see mergeOrder.)
      type: shiftNow(),
      // A takeaway phone sends the bare channel; mergeOrder puts it on this
      // phone's open bill, or opens the next กลับบ้าน#N (and the server has the
      // final say on N — see numberTakeawayOrders).
      table: takeawaySession ? TAKEAWAY_TABLE : tableNo,
      ...(takeawaySession ? { takeawaySession } : {}),
      items: cart.map(item => ({
        name: item.name,
        // English mirrors of name/add-ons ride along so the diner's own bill can
        // read in their language; staff keep seeing the Thai `name`/`addOns`.
        nameEn: item.nameEn,
        menuId: item.menuId,
        group: item.group || 'food',
        category: item.category,
        qty: item.qty,
        price: item.basePrice,
        addonCost: item.addonCost,
        addOns: item.addons,
        addOnsEn: item.addonsEn,
        note: item.note,
        stockRef: item.stockRef || null
      })),
      total: cartTotal,
      status: 'new', // new -> cooking -> served -> paid
      note: cart.map(i => i.note).filter(Boolean).join(' | '),
      by: 'ลูกค้าสแกน'
    };

    // Merge into this table's open bill (as a new round) if it hasn't checked
    // out yet; otherwise this opens a fresh bill.
    setOrders(prev => mergeOrder(prev, newOrder));
    setCart([]);
    setShowCartModal(false);
    setShowSuccessNotice(true);
    setTimeout(() => setShowSuccessNotice(false), 3000);
    setShowStatusList(true); // Auto switch to status page
  };

  // Orders of the CURRENT session at this table only. Once a bill is checked
  // out it becomes 'paid' (and 'cancelled' bills are likewise closed), so the
  // moment customer A pays, their orders drop out of view — the next customer B
  // at the same table sees a clean history with only their own orders. This is
  // the same "active bill" predicate the staff/table-status logic uses.
  // A takeaway phone's "table" is its own bill, matched by session — the QR is
  // shared, so the table value alone would show every takeaway customer's food.
  const isMine = (o) =>
    (takeawaySession ? o.takeawaySession === takeawaySession : String(o.table) === String(tableNo)) &&
    o.status !== 'paid' &&
    o.status !== 'cancelled';
  const tableOrders = orders
    .filter(isMine)
    .sort((a, b) => b.createdAt - a.createdAt);

  // How this phone's place reads: โต๊ะ 5, or กลับบ้าน #3 (just กลับบ้าน before the
  // first order has been given a number).
  const takeawayNo = String(tableOrders[0]?.table || '').split('#')[1];
  const placeLabel = takeawaySession
    ? `${t('กลับบ้าน', 'Takeaway')}${takeawayNo ? ` #${takeawayNo}` : ''}`
    : `${t('โต๊ะ', 'Table')} ${tableNo}`;

  // Once the table has asked to เช็กบิล (or staff have printed it), ordering is
  // locked so the printed total can't drift from the system. The bill carrying
  // the checkout marks the whole table as "settling".
  const checkoutBill = tableOrders.find(o => o.checkout);
  const isSettling = !!checkoutBill;
  const checkoutType = checkoutBill?.checkout?.type || 'normal';
  const grandTotal = tableOrders.reduce((sum, o) => sum + (o.total || 0), 0);

  // เช็กบิลได้ต่อเมื่อเสิร์ฟครบทุกจาน: while a dish is still coming the total on
  // screen is not yet what the table owes, so the button waits instead.
  const unserved = unservedItems(tableOrders);
  const canCheckout = unserved.length === 0;

  // Tap เช็กบิล → stamp every open bill on this table with the chosen checkout
  // type. This both locks ordering here and pops "โต๊ะ X ขอเช็กบิล" on staff.
  const handleRequestCheckout = (type) => {
    if (!canCheckout) return;
    setOrders(prev => prev.map(o =>
      isMine(o)
        ? { ...o, checkout: { stage: 'requested', type, requestedAt: Date.now() } }
        : o
    ));
    setShowCheckoutModal(false);
    setShowCartModal(false);
    setShowStatusList(true);
    showToast(t('แจ้งเช็กบิลให้พนักงานแล้ว', 'Staff have been notified for checkout'));
  };

  return (
    <div ref={rootRef} className="space-y-4 font-thai text-sm">

      {/* ORDER-LOCK BANNER — shown in BOTH the menu and status views while the
          table is checking out, so a diner can't quietly keep ordering. */}
      {isSettling && (
        <div className="rounded-2xl p-3.5 flex items-start gap-3 bg-amber-50 border border-amber-300 text-amber-900">
          <span className="text-xl flex-shrink-0">🧾</span>
          <div className="space-y-0.5">
            <p className="font-kanit font-bold text-sm">
              {t('กำลังอยู่ในขั้นตอนเช็กบิล', 'Checkout in progress')}
              {checkoutType === 'split' && <span className="ml-1">· {t('ไทยช่วยไทย', 'Half-Half')}</span>}
            </p>
            <p className="text-[12px] leading-snug font-medium">
              {t('หากต้องการสั่งเพิ่มกรุณาแจ้งพนักงาน', 'To order more, please ask our staff.')}
            </p>
          </div>
        </div>
      )}

      {/* SUCCESS NOTICE ANIMATED BOUNCE */}
      {showSuccessNotice && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-green-600 text-white py-3 px-6 rounded-2xl shadow-2xl z-[210] flex items-center gap-2 animate-bounce border border-green-500">
          <CheckCircle className="w-5 h-5" />
          <span className="text-xs font-bold font-thai">{t('ส่งรายการอาหารเข้าครัวเรียบร้อยแล้ว!', 'Your order has been sent to the kitchen!')}</span>
        </div>
      )}

      {/* CUSTOM STATUS VIEW TOGGLE */}
      {showStatusList ? (
        <div className="space-y-4">
          <div className="flex justify-between items-center p-2 rounded-xl bg-strip-soft">
            <h2 className="font-extrabold text-base font-kanit">{t('ประวัติการสั่ง', 'Order history ·')} {placeLabel}</h2>
            <button
              onClick={() => setShowStatusList(false)}
              className="text-xs px-3 py-1.5 font-bold rounded-lg border transition-all bg-raised hover:bg-raised-hover border-line-strong text-ink"
            >
              ← {t('กลับไปสั่งอาหาร', 'Back to menu')}
            </button>
          </div>

          <div className="space-y-3.5">
            {tableOrders.length > 0 ? (
              tableOrders.map(order => (
                <div
                  key={order.id}
                  className="border rounded-2xl p-4 shadow-sm relative overflow-hidden transition bg-card border-line"
                >
                  {/* Decorative Ticket Cuts — filled with the page colour so
                      they read as bites taken out of the ticket. */}
                  <div className="absolute top-12 -left-2 w-4 h-4 rounded-full border-r bg-app border-line" />
                  <div className="absolute top-12 -right-2 w-4 h-4 rounded-full border-l bg-app border-line" />

                  <div className="flex justify-between items-center border-b pb-2 mb-2 border-dashed border-line-strong">
                    <span className="font-mono font-bold text-xs text-ink-2">{order.no}</span>
                  </div>

                  <div className="space-y-1.5">
                    {order.items.map((item, idx) => {
                      // Draw a divider whenever a new ordering round begins, so
                      // "ordered more later" is visually separated from the
                      // first order on the same ticket.
                      const showRoundDivider = idx > 0 && itemRound(item) !== itemRound(order.items[idx - 1]);
                      return (
                        <React.Fragment key={idx}>
                          {showRoundDivider && (
                            <div className="flex items-center gap-2 pt-1.5 text-[9px] text-neutral-400 dark:text-[#9B8875] font-semibold">
                              <span className="h-px flex-1 bg-neutral-200 dark:bg-[#4A3A2C]" />
                              {t('สั่งเพิ่ม · รอบที่', 'Added · round')} {itemRound(item)}
                              <span className="h-px flex-1 bg-neutral-200 dark:bg-[#4A3A2C]" />
                            </div>
                          )}
                          {/* A ส่วนลด staff put on the bill reads as one line off
                              the total, not as something ordered — no quantity,
                              and the amount in the minus it actually is. */}
                          {isDiscountItem(item) ? (
                            <div className="flex justify-between items-center text-xs font-bold text-rose-600 dark:text-rose-300">
                              <span>🏷️ {t(item.name, item.nameEn)}</span>
                              <span className="font-mono">-฿{Math.abs(item.price).toLocaleString()}</span>
                            </div>
                          ) : (
                          <div className="flex justify-between items-start text-xs">
                            <div>
                              <span className="font-extrabold text-amber-700 dark:text-[#E8B45C] mr-1.5">{item.qty}×</span>
                              <span className="font-semibold">{t(item.name, item.nameEn)}</span>
                              {item.addOns && item.addOns.length > 0 && (
                                <p className="text-[9px] text-neutral-400 dark:text-[#9B8875] pl-5 font-medium">{t('ตัวเลือก', 'Options')}: {(isEn && item.addOnsEn ? item.addOnsEn : item.addOns).join(', ')}</p>
                              )}
                              {item.note && (
                                <p className="text-[9px] text-orange-900/60 dark:text-[#C9B8A6] pl-5 italic font-medium">📝 "{item.note}"</p>
                              )}
                            </div>
                            <span className="font-mono text-neutral-500 dark:text-[#C9B8A6]">฿{((item.price + (item.addonCost || 0)) * item.qty).toLocaleString()}</span>
                          </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>

                  <div className="border-t border-dashed border-neutral-200/80 dark:border-[#4A3A2C] mt-3 pt-2.5 flex justify-between items-center text-xs">
                    <span className="text-[10px] text-neutral-400 dark:text-[#9B8875] font-medium">{t('สั่งเมื่อ', 'Ordered at')} {order.time} {t('น.', '')}</span>
                    <div>
                      <span className="text-neutral-400 dark:text-[#9B8875] text-[10px] mr-1 font-medium">{t('รวมทั้งสิ้น', 'Total')}</span>
                      <span className="font-mono font-extrabold text-sm text-amber-700 dark:text-[#E8B45C]">฿{order.total.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-10 space-y-2 border border-dashed rounded-2xl border-neutral-200 dark:border-[#4A3A2C]">
                <span className="text-3xl">🧾</span>
                <p className="text-neutral-400 dark:text-[#9B8875] font-medium text-xs">{t('โต๊ะนี้ยังไม่มีข้อมูลออเดอร์ในวันนี้', 'No orders for this table yet')}</p>
                <button
                  onClick={() => setShowStatusList(false)}
                  className="text-xs text-amber-600 dark:text-[#E8B45C] font-bold underline mt-1 block"
                >
                  {t('สั่งอาหารมื้ออร่อยของคุณเลย →', 'Start your order →')}
                </button>
              </div>
            )}
          </div>

          {/* CHECK-OUT FOOTER — grand total + เช็กบิล, or the locked status. */}
          {tableOrders.length > 0 && (
            isSettling ? (
              <div className="rounded-2xl p-4 space-y-1.5 bg-card border border-line text-center">
                <p className="text-[11px] font-bold text-ink-2">
                  {t('ยอดที่ต้องชำระ', 'Amount due')} · {t(
                    checkoutType === 'split' ? 'ไทยช่วยไทย' : 'ปกติ',
                    checkoutType === 'split' ? 'Half-Half' : 'Standard'
                  )}
                </p>
                <p className="font-mono font-extrabold text-2xl text-accent">฿{grandTotal.toLocaleString()}</p>
                <p className="text-[11px] text-ink-2 leading-snug">
                  {t('กรุณารอพนักงานนำใบเสร็จมาที่โต๊ะ', 'Please wait — staff will bring your bill to the table.')}
                </p>
              </div>
            ) : (
              <div className="rounded-2xl p-4 space-y-3 bg-card border border-line">
                <div className="flex justify-between items-center">
                  <span className="font-kanit font-bold text-sm text-title">{t('รวมทั้งโต๊ะ', 'Table total')}</span>
                  <span className="font-mono font-extrabold text-xl text-accent">฿{grandTotal.toLocaleString()}</span>
                </div>
                <button
                  onClick={() => setShowCheckoutModal(true)}
                  disabled={!canCheckout}
                  className={`w-full font-bold py-3.5 rounded-xl transition text-sm flex items-center justify-center gap-2 ${
                    canCheckout
                      ? 'bg-cta hover:bg-cta-hover text-cta-ink shadow-md'
                      : 'bg-strip-soft border border-line text-ink-2 cursor-not-allowed'
                  }`}
                >
                  🧾 {t('เช็กบิล / ชำระเงิน', 'Check out / Pay')}
                </button>
                {/* Why the button is asleep — without this the diner just taps a
                    dead button and calls staff over anyway. */}
                <p className="text-[11px] leading-snug text-center">
                  {canCheckout ? (
                    <span className="text-ink-2">
                      {t(
                        'สามารถกดแจ้งเช็กบิลผ่านหน้าจอเพื่อให้พนักงานนำใบเสร็จมาส่ง หรือหากต้องการให้พนักงานมาให้บริการที่โต๊ะ สามารถเรียกพนักงานได้ตามปกติเช่นกัน 😊',
                        'Tap “Check out” on screen and staff will bring your receipt to the table — or call staff over anytime if you’d like service at your table 😊'
                      )}
                    </span>
                  ) : (
                    <span className="font-semibold text-amber-700 dark:text-[#E8B45C]">
                      {t(
                        `⏳ ยังเสิร์ฟไม่ครบ (เหลืออีก ${unserved.length} รายการ) — เช็กบิลได้เมื่ออาหารมาครบทุกจานแล้ว`,
                        `⏳ ${unserved.length} item${unserved.length > 1 ? 's' : ''} still on the way — checkout opens once everything has been served.`
                      )}
                    </span>
                  )}
                </p>
              </div>
            )
          )}
        </div>
      ) : (
        /* CUSTOMER MENU VIEW */
        <div className="space-y-4">

          {/* STOREFRONT CATEGORY CARDS — shortcuts, not filters: each scrolls to
              its part of the one menu below. A group with nothing in it this
              shift has nothing to scroll to, so its card is not shown. */}
          <div className="grid grid-cols-2 gap-3">
            {GROUPS.filter(group => firstOfGroup(group.key)).map(group => (
              <button
                key={group.key}
                onClick={() => jumpToGroup(group.key)}
                className={`relative h-32 rounded-2xl overflow-hidden shadow-md bg-gradient-to-br flex items-center justify-center transition duration-300 active:scale-[0.98] opacity-90 hover:opacity-100 ${group.fallback}`}
              >
                <img
                  src={group.image[theme] || group.image.day}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
                <span className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/15 to-black/25" />
                <span className="relative font-kanit text-2xl font-bold text-white [text-shadow:0_2px_6px_rgba(0,0,0,0.65)]">
                  {t(group.label, group.labelEn)}
                </span>
              </button>
            ))}
          </div>

          {/* HOW-TO-ORDER STEP GUIDE — สั่งอาหารง่ายๆ ใน 3 ขั้นตอน */}
          <div className="rounded-2xl p-4 bg-card border border-line">
            <h3 className="font-kanit font-bold text-base text-heading mb-3">{t('สั่งอาหารง่ายๆ ใน 3 ขั้นตอน', 'Order in 3 easy steps')}</h3>
            <div className="grid grid-cols-3 gap-2">
              {[
                { n: '1', icon: '📖', title: t('เลือกเมนู', 'Choose'), desc: t('แตะรายการที่ต้องการ', 'Tap a dish you like') },
                { n: '2', icon: '🛒', title: t('ใส่ตะกร้า', 'Add to cart'), desc: t('เลือกตัวเลือกแล้วกดใส่ตะกร้า', 'Pick options, add to cart') },
                { n: '3', icon: '🍽️', title: t('ส่งเข้าครัว', 'Send'), desc: t('กดยืนยันส่งรายการ', 'Confirm to send') },
              ].map(step => (
                <div key={step.n} className="text-center space-y-1">
                  <div className="relative w-11 h-11 mx-auto rounded-full flex items-center justify-center text-xl bg-amber-100">
                    <span>{step.icon}</span>
                    <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-cta text-cta-ink text-[10px] font-bold flex items-center justify-center font-mono">
                      {step.n}
                    </span>
                  </div>
                  <p className="font-kanit font-bold text-xs text-title">{step.title}</p>
                  <p className="text-[10px] text-ink-2 leading-tight">{step.desc}</p>
                </div>
              ))}
            </div>

            {/* ประวัติการสั่ง — right under the steps, where a customer who has
                already ordered is looking. It used to sit at the very bottom of
                the menu, past every dish, which is nowhere near the question
                "ของที่สั่งไปถึงไหนแล้ว". */}
            <button
              onClick={() => setShowStatusList(true)}
              className="mt-3 w-full rounded-xl border border-line bg-well py-2.5 text-xs font-extrabold text-link transition hover:bg-card-hover active:scale-[0.99]"
            >
              {t('ตรวจสอบประวัติการสั่งของโต๊ะนี้ →', 'Check this table’s order history →')}
            </button>
          </div>

          {/* OFF-MENU NOTICE — anything not on the menu, just tell the staff */}
          <div className="rounded-2xl p-3.5 flex items-center gap-3 bg-card border border-line">
            <span className="w-11 h-11 rounded-full flex items-center justify-center text-xl bg-amber-100 flex-shrink-0">🛎️</span>
            <p className="text-[13px] font-semibold text-ink leading-relaxed">
              {t('หากต้องการสั่งอะไรนอกเหนือจากเมนู โปรดเเจ้งพนักงาน 😊', 'Want something not on the menu? Just let our staff know!')}
            </p>
          </div>

          {/* MENU SECTIONS */}
          {sections.length > 0 ? (
            sections.map(section => (
              // scroll-mt keeps the heading clear of the sticky header when a
              // shortcut card jumps here, instead of parking it underneath.
              <div
                key={section.category}
                id={section === firstOfGroup(section.group) ? anchorFor(section.group) : undefined}
                className="space-y-3 scroll-mt-24"
              >
                <h2 className="font-kanit text-xl font-semibold text-heading">
                  {t(section.category, section.categoryEn)}
                </h2>

                {section.items.map(dish => {
                  const available = isAvailable(dish);
                  return (
                  <div
                    key={dish.id}
                    onClick={() => handleOpenDetail(dish)}
                    className={`rounded-3xl p-3.5 flex items-center gap-3.5 transition duration-300 bg-card hover:bg-card-hover ${available ? 'cursor-pointer active:scale-[0.99]' : 'opacity-55'} ${isDay ? 'shadow-[0_6px_20px_-8px_rgba(90,46,20,0.28)] hover:shadow-[0_10px_26px_-8px_rgba(90,46,20,0.35)]' : 'border border-line shadow-[0_6px_20px_-10px_rgba(0,0,0,0.8)]'}`}
                  >
                    {/* The emoji shows instantly as a placeholder; the photo is
                        layered over it and fades in only once decoded, so a slow
                        image never leaves a blank square. decoding="async" keeps
                        the paint off the main thread while scrolling. */}
                    <div className={`relative w-[88px] h-[88px] rounded-2xl flex-shrink-0 flex items-center justify-center text-4xl overflow-hidden ${isDay ? 'bg-gradient-to-b from-well to-well-2' : 'bg-well border border-line'}`}>
                      <span>{dish.emoji || '🍽️'}</span>
                      {dish.image && (
                        <img
                          src={resolveImageUrl(dish.image)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          width={88}
                          height={88}
                          onLoad={(e) => { e.currentTarget.style.opacity = '1'; }}
                          className="absolute inset-0 w-full h-full object-cover opacity-0 transition-opacity duration-300"
                        />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <h4 className="font-kanit font-bold text-[17px] leading-snug truncate text-title">
                        {t(dish.name, dish.nameEn)}
                      </h4>
                      {subtitleOf(dish) && (
                        <p className="text-sm truncate mt-0.5 text-ink-2">{subtitleOf(dish)}</p>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <span className="font-kanit font-bold text-lg text-accent">
                          {dish.price}.-
                        </span>
                        {!available && (
                          <span className="text-[10px] text-red-600 bg-red-100 px-2 py-0.5 rounded-full font-semibold">
                            {t('หมดชั่วคราว', 'Sold out')}
                          </span>
                        )}
                      </div>
                    </div>

                    {available && (
                      <span className="w-14 h-14 rounded-full flex-shrink-0 flex items-center justify-center shadow-md transition bg-add hover:bg-add-hover text-add-ink">
                        <ShoppingBasket className="w-6 h-6" />
                      </span>
                    )}
                  </div>
                  );
                })}
              </div>
            ))
          ) : (
            <div className="text-center py-10 text-xs font-medium text-ink-3">{t('ยังไม่มีรายการเมนูในหมวดนี้', 'No items in this category yet')}</div>
          )}

        </div>
      )}

      {/* FLOATING CART BAR — hidden while checking out (ordering is locked). */}
      {cartCount > 0 && !showStatusList && !isSettling && (
        <div className="fixed bottom-14 left-0 right-0 max-w-md mx-auto px-4 py-2 z-30 pointer-events-none">
          <button
            onClick={() => setShowCartModal(true)}
            className="w-full font-bold rounded-2xl p-3 flex items-center justify-between gap-3 shadow-2xl pointer-events-auto transition hover:scale-[1.02] active:scale-[0.98] bg-cta hover:bg-cta-hover text-cta-ink"
          >
            <div className="flex items-center gap-2">
              <div className="relative">
                <span className={`p-1.5 rounded-lg block ${isDay ? 'bg-white/20' : 'bg-black/15'}`}>
                  <ShoppingBag className="w-4 h-4" />
                </span>
                <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[9px] w-4.5 h-4.5 rounded-full flex items-center justify-center font-bold font-mono">
                  {cartCount}
                </span>
              </div>
              <span className="text-xs font-thai font-semibold">{t('ดูรายการในตะกร้า', 'View cart')}</span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[10px] opacity-75 font-normal">{t('ราคารวม', 'Total')}</span>
              <span className="font-mono text-sm font-extrabold">฿{cartTotal.toLocaleString()}</span>
            </div>
          </button>
        </div>
      )}

      {/* RETURN TO TOP — a small arrow at the bottom-right that jumps back up to
          the food/drink tabs. Sits above the floating cart bar so the two never
          overlap; only shown in the menu view once scrolled down. */}
      {showTopBtn && !showStatusList && (
        <button
          onClick={scrollToTop}
          aria-label={t('กลับขึ้นบนสุด', 'Back to top')}
          className={`fixed right-4 z-40 w-12 h-12 rounded-full flex items-center justify-center shadow-2xl ring-1 ring-black/10 transition hover:scale-105 active:scale-95 bg-cta hover:bg-cta-hover text-cta-ink ${cartCount > 0 && !isSettling ? 'bottom-28' : 'bottom-20'}`}
        >
          <ArrowUp className="w-6 h-6 stroke-[2.5]" />
        </button>
      )}

      {/* DETAIL MODAL WITH CUSTOM ADDONS */}
      {selectedItem && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[100] flex items-end justify-center p-0">
          <div className={`rounded-t-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 max-h-[85vh] overflow-y-auto shadow-2xl border-t ${isDay ? 'surface-light bg-white border-neutral-100' : 'bg-black border-neutral-800'}`}>

            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-base font-extrabold font-kanit">{t(selectedItem.name, selectedItem.nameEn)}</h3>
                <span className="text-amber-600 font-extrabold font-mono text-base block mt-0.5">฿{basePriceOf(selectedItem, selectedOption)}</span>
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

            {/* OPTION CHOICE (required) — protein for food, size (M/L) for drinks */}
            {selectedItem.options && selectedItem.options.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400">
                  {selectedItem.options.every(o => ['M', 'L', 'S'].includes(o.name))
                    ? t('เลือกขนาด', 'Select size')
                    : t('เลือกเนื้อสัตว์', 'Select protein')}
                </h4>
                <div className="grid grid-cols-2 gap-1.5">
                  {selectedItem.options.map(opt => (
                    <label
                      key={opt.name}
                      className={`flex items-center justify-between p-2.5 border rounded-xl cursor-pointer transition text-xs font-thai ${selectedOption?.name === opt.name ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500 dark:bg-amber-500/15 dark:border-amber-400 dark:ring-amber-400' : 'border-neutral-150 hover:bg-neutral-50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="option-choice"
                          checked={selectedOption?.name === opt.name}
                          onChange={() => setSelectedOption(opt)}
                          className="w-4 h-4 text-amber-600 border-neutral-300 focus:ring-amber-500"
                        />
                        <span className="font-semibold text-neutral-700">{t(opt.name, opt.nameEn)}</span>
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
                  {t(group.name, group.nameEn)}
                </h4>
                <div className="grid grid-cols-2 gap-1.5">
                  {group.options.map(opt => (
                    <label
                      key={opt.name}
                      className={`flex items-center justify-between p-2.5 border rounded-xl cursor-pointer transition text-xs font-thai ${selectedChoices[group.name]?.name === opt.name ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500 dark:bg-amber-500/15 dark:border-amber-400 dark:ring-amber-400' : 'border-neutral-150 hover:bg-neutral-50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`choice-${group.name}`}
                          checked={selectedChoices[group.name]?.name === opt.name}
                          onChange={() => handleChoiceChange(group.name, opt)}
                          className="w-4 h-4 text-amber-600 border-neutral-300 focus:ring-amber-500"
                        />
                        <span className="font-semibold text-neutral-700">{t(opt.name, opt.nameEn)}</span>
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
              <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400">{t('ตัวเลือกเพิ่มเติม', 'Add-ons')}</h4>
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
                        onChange={(e) => handleAddonChange(addon, e.target.checked)}
                        className="w-4 h-4 text-amber-600 border-neutral-300 rounded focus:ring-amber-500"
                      />
                      <span className="font-semibold text-neutral-700">{t(addon.name, addon.nameEn)}</span>
                    </div>
                    <span className="text-neutral-500 font-bold font-mono">+฿{addon.price}</span>
                  </label>
                ))}
              </div>
            </div>
            )}

            {/* CUSTOM NOTES */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">{t('หมายเหตุเพิ่มเติมถึงครัว', 'Note to the kitchen')}</label>
              <textarea
                value={modalNotes}
                onChange={e => setModalNotes(e.target.value)}
                placeholder={t('เช่น ขอเผ็ดน้อยมาก, ไม่ใส่ผักชี, หรืออื่นๆ...', 'e.g. less spicy, no coriander, etc.')}
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
                {t('ใส่ตะกร้าสินค้า', 'Add to cart')} (฿{((basePriceOf(selectedItem, selectedOption) + selectedAddons.reduce((sum, a) => sum + a.price, 0) + choicesCost(selectedChoices)) * modalQty).toLocaleString()})
              </button>
            </div>

          </div>
        </div>
      )}

      {/* VIEW CART OVERLAY SHEET */}
      {showCartModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[100] flex items-end justify-center p-0">
          <div className="surface-light bg-white rounded-t-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 max-h-[85vh] overflow-y-auto shadow-2xl border-t border-neutral-100">

            <div className="flex justify-between items-center">
              <h3 className="text-base font-extrabold font-kanit flex items-center gap-2">
                <ShoppingBag className="text-amber-600 w-5 h-5" />
                <span>{t('ตะกร้าสินค้าของคุณ', 'Your cart')} ({placeLabel})</span>
              </h3>
              <button
                onClick={() => setShowCartModal(false)}
                className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {/* CART ITEMS LIST */}
            <div className="divide-y divide-neutral-100 max-h-60 overflow-y-auto pr-1">
              {cart.map(cartItem => (
                <div key={cartItem.id} className="py-3.5 flex justify-between items-start text-xs font-thai">
                  <div className="space-y-1 pr-4">
                    <span className="font-extrabold text-neutral-800 text-sm">{t(cartItem.name, cartItem.nameEn)} <b className="text-amber-700">x{cartItem.qty}</b></span>
                    {cartItem.addons.length > 0 && (
                      <p className="text-[10px] text-neutral-400 font-medium">{t('พิเศษ', 'Extras')}: {(isEn && cartItem.addonsEn ? cartItem.addonsEn : cartItem.addons).join(', ')}</p>
                    )}
                    {cartItem.note && (
                      <p className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-lg inline-block italic">{t('รายละเอียด', 'Note')}: "{cartItem.note}"</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3.5">
                    <span className="font-mono font-extrabold text-neutral-800">฿{((cartItem.basePrice + cartItem.addonCost) * cartItem.qty).toLocaleString()}</span>
                    <button
                      onClick={() => handleRemoveCartItem(cartItem.id)}
                      className="text-red-500 hover:text-red-700 p-1 rounded-lg hover:bg-red-50 transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* TOTAL */}
            <div className="space-y-3 pt-3 border-t border-neutral-100">
              <div className="flex justify-between text-base font-extrabold font-kanit">
                <span>{t('ราคารวมสุทธิ', 'Total')}</span>
                <span className="text-amber-600 font-mono text-lg">฿{cartTotal.toLocaleString()}</span>
              </div>

              <button
                onClick={handlePlaceOrder}
                className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3.5 rounded-xl transition text-sm flex items-center justify-center gap-2 shadow-md"
              >
                <span>{t('ส่งรายการเข้าห้องครัวเลย ✓', 'Send order to kitchen ✓')}</span>
              </button>
            </div>

          </div>
        </div>
      )}

      {/* CHECK-OUT TYPE CHOICE — ปกติ (เงินสด/QR ร้าน) vs คนละครึ่ง */}
      {showCheckoutModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[100] flex items-end justify-center p-0">
          <div className="surface-light bg-white rounded-t-3xl max-w-md w-full p-6 space-y-4 animate-slide-up text-neutral-800 shadow-2xl border-t border-neutral-100">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-base font-extrabold font-kanit">{t('เลือกวิธีเช็กบิล', 'Choose checkout')}</h3>
                <span className="text-amber-600 font-extrabold font-mono text-base block mt-0.5">฿{grandTotal.toLocaleString()}</span>
              </div>
              <button
                onClick={() => setShowCheckoutModal(false)}
                className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <button
              onClick={() => handleRequestCheckout('normal')}
              className="w-full text-left p-4 border border-neutral-200 rounded-2xl hover:border-amber-500 hover:bg-amber-50 transition flex items-center gap-3"
            >
              <span className="text-2xl">💵</span>
              <div>
                <p className="font-kanit font-bold text-sm">{t('เช็กบิลปกติ', 'Standard checkout')}</p>
                <p className="text-[11px] text-neutral-500">{t('เงินสด หรือ สแกน QR ของร้าน', 'Cash or scan the shop QR')}</p>
              </div>
            </button>

            <button
              onClick={() => handleRequestCheckout('split')}
              className="w-full text-left p-4 border border-neutral-200 rounded-2xl hover:border-amber-500 hover:bg-amber-50 transition flex items-center gap-3"
            >
              <span className="text-2xl">🇹🇭</span>
              <div>
                <p className="font-kanit font-bold text-sm">{t('เช็กบิลไทยช่วยไทย', 'Half-Half (ไทยช่วยไทย)')}</p>
                <p className="text-[11px] text-neutral-500">{t('ใช้สิทธิ์ไทยช่วยไทย — พนักงานจะนำถุงเงินมาสแกน', 'Use ไทยช่วยไทย — staff will bring the ถุงเงิน phone')}</p>
              </div>
            </button>

            <p className="text-[11px] text-neutral-400 text-center leading-snug">
              {t('เมื่อกดเลือก ระบบจะล็อกการสั่งอาหารและแจ้งพนักงานให้มาเก็บเงินที่โต๊ะ', 'After choosing, ordering locks and staff are notified to collect payment at your table.')}
            </p>
          </div>
        </div>
      )}

    </div>
  );
}

export default CustomerView;
