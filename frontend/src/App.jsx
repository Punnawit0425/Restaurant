import React, { useState, useEffect, useRef, useCallback } from 'react';
import CustomerView from './components/CustomerView';
import StaffView from './components/StaffView';
import OwnerView from './components/OwnerView';
import InventoryView from './components/InventoryView';
import LoginPage from './components/LoginPage';
import { fetchState, saveResource, subscribeToState, login, claimAccount, setAuthToken } from './api';
import { shiftNow } from './shift';
import { normalizeGroupStore } from './menu-groups';
import {
  tableForScan,
  resolveSeating,
  readTableFollow,
  writeTableFollow,
  readSeenBills,
  writeSeenBills,
  clearSeating,
} from './table-follow';
import {
  readSeat,
  writeSeat,
  clearSeat,
  stripTableParams,
} from './customer-session';
import { takeawaySessionId } from './takeaway-session';
import { tableLabel, takeawayBillIndex } from './orders';
import { ShieldCheck, Key, Package, LogOut, Smartphone, Languages, ChevronDown } from 'lucide-react';
import logoImg from './assets/logo.jpg';

const DEFAULT_MENU = [
  // Day Menu
  { id: 'd1', name: 'ผัดไทยกุ้งสด', price: 90, category: 'แนะนำ', theme: 'day', emoji: '🍤', desc: 'เส้นจันท์เหนียวนุ่มผัดซอสสูตรเด็ดของบ้านยาย เสิร์ฟพร้อมกุ้งสดตัวโต', available: true, stockRef: 'DST01' },
  { id: 'd2', name: 'ต้มยำกุ้งน้ำข้น', price: 150, category: 'แนะนำ', theme: 'day', emoji: '🍲', desc: 'เผ็ดร้อนถึงใจด้วยสมุนไพรสดและกุ้งแม่น้ำตัวใหญ่สุกกำลังดี', available: true, stockRef: 'DST01' },
  { id: 'd3', name: 'ข้าวผัดปู', price: 120, category: 'แนะนำ', theme: 'day', emoji: '🦀', desc: 'ข้าวหอมมะลิผัดร่วนเคลือบไข่ โรยด้วยเนื้อปูก้อนแน่นหวานฉ่ำ', available: true, stockRef: 'DST02' },
  { id: 'd4', name: 'ข้าวกระเพราหมูสับ/เนื้อสับ', price: 60, category: 'จานเดียว', theme: 'day', emoji: '🍳', desc: 'กะเพราแท้รสชาติเผ็ดร้อนดุดัน ผัดกระเทียมพริกแห้งหอมกรุ่น', available: true },
  { id: 'd5', name: 'ข้าวผัดกระเทียมหอมมะลิ', price: 55, category: 'จานเดียว', theme: 'day', emoji: '🧄', desc: 'ข้าวหอมมะลิผัดซอสกระเทียมกระทะเหล็ก หอมฟุ้งกรอบนอกนุ่มใน', available: true },
  { id: 'd6', name: 'ผัดคะน้าหมูกรอบราดข้าว', price: 70, category: 'จานเดียว', theme: 'day', emoji: '🥬', desc: 'หมูกรอบสุกกรอบนอกนุ่มใน ผัดกับคะน้าฮ่องกงซอสเข้มข้น', available: true },
  { id: 'd7', name: 'ต้มยำกุ้งน้ำข้นสูตรพิเศษ', price: 120, category: 'กับข้าว', theme: 'day', emoji: '🍲', desc: 'ต้มยำกุ้งแม่น้ำน้ำข้นมันกุ้งเยิ้มๆ รสกลมกล่อม', available: true },
  { id: 'd8', name: 'ไข่เจียวสมุนไพรทรงเครื่อง', price: 80, category: 'กับข้าว', theme: 'day', emoji: '🍳', desc: 'ไข่ดาวทอดฟูหนานุ่ม ผสมหัวหอม ใบมะกรูด และพริกขี้หนูสด', available: true },
  { id: 'd9', name: 'ยำวุ้นเส้นทะเล', price: 110, category: 'ต้ม & ยำ', theme: 'day', emoji: '🥗', desc: 'วุ้นเส้นคลุกเคล้าน้ำยำสามรส กุ้ง ปลาหมึกสด รสจัดจ้านถึงใจ', available: true },
  { id: 'd10', name: 'ต้มข่าไก่', price: 90, category: 'ต้ม & ยำ', theme: 'day', emoji: '🥥', desc: 'เนื้ออกไก่นุ่มในน้ำซุปกะทิสดสมุนไพร กลิ่นหอมข่าอ่อนๆ', available: true },
  { id: 'd11', name: 'ผัดคะน้าหมูกรอบ', price: 90, category: 'ผัด', theme: 'day', emoji: '🥬', desc: 'คะน้าฮ่องกงผัดหมูกรอบจานใหญ่ ทานคู่ข้าวสวยร้อนๆ', available: true },
  { id: 'd12', name: 'ผัดซีอิ๊วเส้นใหญ่', price: 70, category: 'ผัด', theme: 'day', emoji: '🍜', desc: 'เส้นใหญ่ผัดซีอิ๊วดำหอมกลิ่นกระทะเหล็ก ใส่คะน้าและหมูหมักนุ่ม', available: true },
  { id: 'd13', name: 'ข้าวสวย', price: 15, category: 'ข้าว', theme: 'day', emoji: '🍚', desc: 'ข้าวหอมมะลิสุรินทร์เกรดพรีเมียม หุงร้อนใหม่ทุกวัน', available: true },
  { id: 'd14', name: 'ข้าวเหนียว', price: 15, category: 'ข้าว', theme: 'day', emoji: '🍙', desc: 'ข้าวเหนียวเขี้ยวงูเม็ดสวย นุ่มเหนียวร้อนๆ', available: true },
  { id: 'd15', name: 'ข้าวเหนียวมะม่วง', price: 80, category: 'ของหวาน', theme: 'day', emoji: '🥭', desc: 'ข้าวเหนียวมูนกะทิเข้มข้น ทานคู่กับมะม่วงน้ำดอกไม้สุกสีทองหวานฉ่ำ', available: true, stockRef: 'DST03' },
  { id: 'd16', name: 'บัวลอยไข่หวาน', price: 45, category: 'ของหวาน', theme: 'day', emoji: '🍮', desc: 'บัวลอยแป้งนุ่มต้มในน้ำกะทิมะพร้าวอ่อนใบเตย พร้อมไข่หวานยางมะตูม', available: true },
  { id: 'd17', name: 'ชาไทยเย็น', price: 40, category: 'เครื่องดื่ม', theme: 'day', emoji: '🧋', desc: 'ชาไทยคัดพิเศษ ชงใส่นมข้นหวานมัน ท็อปด้วยนมข้นจืดเย็นฉ่ำ', available: true },
  { id: 'd18', name: 'น้ำเปล่า', price: 15, category: 'เครื่องดื่ม', theme: 'day', emoji: '💧', desc: 'น้ำดื่มบรรจุขวดเสิร์ฟพร้อมน้ำแข็งแก้วเย็นระยับ', available: true },
  { id: 'd19', name: 'โซดามะนาว', price: 45, category: 'เครื่องดื่ม', theme: 'day', emoji: '🍹', desc: 'น้ำมะนาวแท้คั้นสด ผสมน้ำเชื่อมใบเตยและโซดาซ่าสะใจ', available: true },
  
  // Night Menu
  { id: 'n1', name: 'ค็อกเทล Signature Blue Ocean', price: 220, category: 'เครื่องดื่ม', theme: 'night', emoji: '🍸', desc: 'ค็อกเทลสีฟ้าครามสดใส รสชาติอมเปรี้ยวหวานสดชื่นจากบลูคูราโซและเลมอน', available: true, stockRef: 'ST01' },
  { id: 'n2', name: 'เบียร์คราฟต์รสพีช', price: 180, category: 'เครื่องดื่ม', theme: 'night', emoji: '🍺', desc: 'เบียร์คราฟต์รสเบาละมุน หอมกลิ่นพีชญี่ปุ่นเข้มข้น ดื่มง่ายดื่มด่ำ', available: true, stockRef: 'ST02' },
  { id: 'n3', name: 'วิสกี้พรีเมียม (ช็อต)', price: 150, category: 'เครื่องดื่ม', theme: 'night', emoji: '🥃', desc: 'ซิงเกิลมอลต์วิสกี้บ่ม 12 ปี เสิร์ฟเย็นพร้อมน้ำแข็งกลมขนาดใหญ่สลายช้า', available: true, stockRef: 'ST03' },
  { id: 'n4', name: 'โซดาเกลือหิมะ', price: 80, category: 'เครื่องดื่ม', theme: 'night', emoji: '🧂', desc: 'โซดาแช่เย็นจัดในแก้วแช่แข็ง ขอบแก้วเคลือบด้วยเกลือหิมะฝอยละเอียดตัดรสชาติ', available: true, stockRef: 'ST04' },
  { id: 'n5', name: 'เฟรนช์ฟรายส์ทรัฟเฟิลชีส', price: 140, category: 'ของกินเล่น', theme: 'night', emoji: '🍟', desc: 'มันฝรั่งแท่งใหญ่ทอดกรอบสีทอง คลุกผงชีสและราดด้วยซอสครีมเห็ดทรัฟเฟิลหอมตลบ', available: true },
  { id: 'n6', name: 'ข้อไก่ทอดงาสามสี', price: 120, category: 'ของกินเล่น', theme: 'night', emoji: '🍗', desc: 'ข้อกระดูกอ่อนไก่ชุบแป้งบางๆ ทอดโรยด้วยงาขาว งาดำ และงาขี้ม้อนกรุบกรอบ', available: true }
];

// Extras, scoped per storefront so เรินเก่า and the day shop never borrow each
// other's list while running the same food/drink rules. Replaced by the sheet's
// รายการเสริม rows once the backend responds — these only cover the first render.
const DEFAULT_ADDONS = {
  day: {
    food: [
      { id: 'a1', name: 'ไข่เจียว', price: 10 },
      { id: 'a2', name: 'ไข่ดาว', price: 10 }
    ],
    drink: [],
  },
  night: {
    food: [],
    // Bar extras go with the drinks they belong to, the same way a day topping
    // sits under drink rather than being offered on every dish.
    drink: [
      { id: 'a4', name: 'เพิ่มถังน้ำแข็งเกล็ดโต', price: 20 },
      { id: 'a5', name: 'เลมอนฝานนำเข้า', price: 15 }
    ],
  },
};

// Pick-exactly-one groups (ขนาด / ระดับความหวาน), same shape. Both shifts build
// them from their own รายการเสริม rows.
const DEFAULT_CHOICES = {
  day: { food: [], drink: [] },
  night: { food: [], drink: [] },
};

const DEFAULT_STOCK = {
  // Day-shift stock (kitchen ingredients / limited daily dishes).
  DST01: { name: 'กุ้งสด (ผัดไทย/ต้มยำ)', count: 30, min: 8, theme: 'day' },
  DST02: { name: 'เนื้อปูก้อน (ข้าวผัดปู)', count: 15, min: 4, theme: 'day' },
  DST03: { name: 'มะม่วงน้ำดอกไม้สุก', count: 12, min: 4, theme: 'day' },
  DST04: { name: 'ไข่ไก่สด', count: 60, min: 15, theme: 'day' },
  // Night-shift stock (bar drinks).
  ST01: { name: 'ค็อกเทล Signature Blue Ocean', count: 24, min: 5, theme: 'night' },
  ST02: { name: 'เบียร์คราฟต์รสพีช', count: 8, min: 10, theme: 'night' },
  ST03: { name: 'วิสกี้พรีเมียม (ช็อต)', count: 45, min: 15, theme: 'night' },
  ST04: { name: 'โซดาเกลือหิมะ', count: 2, min: 12, theme: 'night' }
};

const DEFAULT_STAFF = [
  { user: 'admin', pass: '1234', name: 'ผู้จัดการร้าน' }
];

const DEFAULT_SETTINGS = {
  name: 'ตู้กับข้าวบ้านยาย',
  nameNight: 'เรือนเก่า',
  tables: 12,
  baseUrl: '',
  // PromptPay ID of the shop (mobile no. or citizen ID) — powers the
  // pay-by-QR option at checkout. Empty disables the QR choice.
  promptpayId: ''
};

// There is deliberately no readSession() here. A login is never written to
// disk (see api.js): every fresh page load starts signed out, for staff and
// owner alike, so opening the link on the till hands over the login page rather
// than yesterday's back office.

// A customer arrives via a table link. Four URL shapes are accepted:
//   ?table=N       → table N, shift decided by the Bangkok clock (shiftNow())
//   ?table-day=N   → table N, shift LOCKED to the day storefront
//   ?table-night=N → table N, shift LOCKED to the night bar
//   ?takeaway      → สั่งกลับบ้าน: no table; each phone opens its own
//                    กลับบ้าน#N bill (see takeaway-session.js)
// ?table=N is what the printed table stickers carry (one per table). The two
// locked shapes are kept for stickers printed before the switch, and for
// hand-made links when a shop wants to pin a table to one menu.
// Returns { table:Number, shift:'day'|'night'|null } or null when none is
// present (null shift means "let the clock decide"). This is the single source
// of truth for how a QR scan maps to a table + shift.
function readTableParam() {
  const params = new URLSearchParams(window.location.search);
  const num = (v) => {
    const n = parseInt(v);
    return !isNaN(n) && n > 0 ? n : null;
  };
  const day = num(params.get('table-day'));
  if (day) return { table: day, shift: 'day' };
  const night = num(params.get('table-night'));
  if (night) return { table: night, shift: 'night' };
  const plain = num(params.get('table'));
  if (plain) return { table: plain, shift: null };
  if (params.has('takeaway')) return { table: null, takeaway: true, shift: null };
  return null;
}

// Where this tab is seated: the QR link it has just been opened with, or — once
// that link has been wiped off the URL (see stripTableParams) — the seat kept in
// sessionStorage. Everything that used to read the URL param goes through here,
// so cleaning the address bar changes nothing about how the app behaves.
function readSeating() {
  const tp = readTableParam();
  if (tp) return { ...tp, scanned: true };
  const seat = readSeat();
  return seat ? { table: seat.table, takeaway: !!seat.takeaway, shift: seat.shift, scanned: false } : null;
}

// The number printed on the QR this phone scanned — the anchor a ย้ายโต๊ะ follow
// and the เช็กบิล lock both hang off. Read from the seat, so it survives both a
// reload and the cleaned URL.
function scanAnchor() {
  return readSeating()?.table ?? null;
}

function App() {
  const [theme, setTheme] = useState(() => {
    // A customer arriving via a table QR is pinned to their shift from the very
    // first frame — so a day diner never flashes the night palette (or vice-
    // versa) from a stale saved theme. An explicit ?table-day / ?table-night
    // link fixes the shift; a plain ?table falls back to the clock.
    const seating = readSeating();
    if (seating) return seating.shift || shiftNow();
    return localStorage.getItem('activeTheme') || 'day';
  });
  // The active screen. Access is decided up-front, not switchable at will:
  //   • a table QR (…?table=N) is the ONLY way to become a 'customer';
  //   • everyone else lands on the 'login' page — including a staff member or
  //     owner who was signed in a moment ago, because a session lives only as
  //     long as the page does.
  // This is what keeps each role boxed into its own view — there is no dropdown
  // to hop between them anymore.
  //
  // A seat held in sessionStorage counts as a scan for as long as the tab lives
  // — that is what lets the QR link be wiped from the URL without a reload
  // dropping the diner back onto the login page. Diners are unaffected by the
  // no-remembered-login rule: they never sign in at all.
  const [role, setRole] = useState(() => (readSeating() ? 'customer' : 'login'));
  const [tableNo, setTableNo] = useState(() => {
    const seating = readSeating();
    // A phone that was re-seated resumes at its new table straight away, so a
    // refresh never flashes (or sticks on) the number printed on the old QR.
    if (seating && !seating.takeaway) return tableForScan(seating.table);
    return parseInt(localStorage.getItem('tableNo') || '1');
  });
  // สั่งกลับบ้าน: this phone's takeaway session id when the tab was opened from
  // the takeaway QR, else null. It — not `tableNo` — decides which bill this
  // phone orders onto; see takeawayBillIndex in orders.js.
  const [takeawaySession, setTakeawaySession] = useState(() =>
    readSeating()?.takeaway ? takeawaySessionId() : null
  );
  // Customer-facing menu language ('th' | 'en'). Only the customer view reads
  // it; staff and owner panels stay Thai. Persisted so a foreign diner's choice
  // survives a page reload.
  const [lang, setLang] = useState(() => localStorage.getItem('lang') || 'th');
  // --- SHARED STATE (lives on the backend, cached here) --------------------
  // These are seeded with local defaults only for the first render; the real
  // values arrive from the backend a moment later and are then kept in sync
  // across every open tab via the SSE stream (see the effect further down).
  const [menu, setMenuLocal] = useState(DEFAULT_MENU);
  const [stock, setStockLocal] = useState(DEFAULT_STOCK);
  const [staff, setStaffLocal] = useState(DEFAULT_STAFF);
  const [settings, setSettingsLocal] = useState(DEFAULT_SETTINGS);
  const [orders, setOrdersLocal] = useState([]);
  // Owner-recorded outgoings. Empty until the backend answers.
  const [expenses, setExpensesLocal] = useState([]);
  // Staff clock-in/out records. Server-owned: read-only here, appended to only
  // via the /api/timeclock/clock endpoint (which then broadcasts over SSE).
  const [timeclock, setTimeclockLocal] = useState([]);
  // Monthly payroll status keyed "user__YYYY-MM" -> 'paid'. Server-owned too.
  const [payroll, setPayrollLocal] = useState({});
  // Extras come from the sheet via the backend; fall back to the local
  // defaults for anything it doesn't carry (i.e. the night bar).
  const [addons, setAddonsLocal] = useState(DEFAULT_ADDONS);
  const [choices, setChoicesLocal] = useState(DEFAULT_CHOICES);
  // ตัวเลือกเสริม the owner authored: reusable sets of extras attached to dishes
  // by id (see menu-groups.js). Starts null, NOT [] — an empty array is a real
  // answer ("no presets"), while null means the backend has not said yet, and
  // the order dialogs fall back to the derived addons/choices until it does.
  const [addonPresets, setAddonPresetsLocal] = useState(null);
  // กลุ่มเมนู the owner saved for the สถิติเมนู table — a named set of dish ids and
  // nothing more. [] rather than null: unlike addonPresets nothing falls back to
  // a derived value while the backend is quiet, and "no presets yet" is exactly
  // what the empty dropdown should say on the first render.
  const [menuPresets, setMenuPresetsLocal] = useState([]);

  // Refs mirror the latest value of each shared resource so the wrapped
  // setters below can compute functional updates (prev => next) without going
  // stale, even right after an SSE push.
  const ordersRef = useRef(orders);
  const stockRef = useRef(stock);
  const staffRef = useRef(staff);
  const settingsRef = useRef(settings);
  const expensesRef = useRef(expenses);
  useEffect(() => { expensesRef.current = expenses; }, [expenses]);
  useEffect(() => { ordersRef.current = orders; }, [orders]);
  useEffect(() => { stockRef.current = stock; }, [stock]);
  useEffect(() => { staffRef.current = staff; }, [staff]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const addonPresetsRef = useRef(addonPresets);
  useEffect(() => { addonPresetsRef.current = addonPresets; }, [addonPresets]);
  const menuPresetsRef = useRef(menuPresets);
  useEffect(() => { menuPresetsRef.current = menuPresets; }, [menuPresets]);

  // --- Echo guard: why the board used to flicker on a slow link -------------
  // Every write is answered by an SSE push of the WHOLE state, and that push
  // comes back to the tab that made the write as well. One tap can fire more
  // than one write — "เสิร์ฟครบทุกจาน" saves `stock` and `orders` together —
  // and the first write's echo is a snapshot the server took BEFORE the second
  // one landed. Applying it puts the board back the way it was until the second
  // echo arrives. On localhost that gap is a millisecond and nobody sees it;
  // over the internet (Railway) it is a few hundred, which is exactly the
  // กระตุก staff were seeing.
  //
  // So: while this tab has a write to a resource in flight, an incoming push is
  // not allowed to touch THAT resource — our own optimistic value is the newer
  // one by definition. The short tail after the response covers an echo that
  // was already on the wire when the server processed our write.
  //
  // Dropping a push is safe but not free: it might have carried a change made on
  // ANOTHER device (a diner ordering while we tap). So a dropped push is
  // remembered, and once our own writes have settled we re-read the state from
  // the server — a fresh read, never the stale snapshot we threw away.
  const ECHO_SETTLE_MS = 400;
  const writesInFlight = useRef({});
  const missedPush = useRef({});
  const applyStateRef = useRef(null);
  const isWriting = (resource) => (writesInFlight.current[resource] || 0) > 0;

  // The last payload we applied (or sent) for each resource, serialised. A push
  // carries everything, so without this every push hands React brand-new arrays
  // for the menu, the orders and the rest — re-rendering the whole app even when
  // nothing about them changed. Comparing here lets an unchanged resource keep
  // its identity, and React skips the render entirely.
  const appliedRef = useRef({});
  const isNewPayload = (resource, value) => {
    const json = JSON.stringify(value);
    if (appliedRef.current[resource] === json) return false;
    appliedRef.current[resource] = json;
    return true;
  };

  // Wrapped setters: update this tab immediately (optimistic) AND push the new
  // value to the backend, which broadcasts it to all other tabs. They accept
  // either a value or an updater function, exactly like a useState setter, so
  // the child components need no changes.
  const makeSetter = (resource, setLocal, ref) =>
    (updater) => {
      const next = typeof updater === 'function' ? updater(ref.current) : updater;
      ref.current = next;
      setLocal(next);
      // Record what we sent, so the echo of our own write reads as "nothing
      // new" and costs no re-render at all.
      isNewPayload(resource, next);
      writesInFlight.current[resource] = (writesInFlight.current[resource] || 0) + 1;
      // A 401 means our staff session expired — drop it and ask to log in again.
      saveResource(resource, next, handleSessionExpired).finally(() => {
        setTimeout(() => {
          writesInFlight.current[resource] = Math.max(0, (writesInFlight.current[resource] || 0) - 1);
          if (isWriting(resource) || !missedPush.current[resource]) return;
          // We ignored someone else's push while writing — catch up for real.
          missedPush.current[resource] = false;
          fetchState().then((s) => applyStateRef.current?.(s)).catch(() => {});
        }, ECHO_SETTLE_MS);
      });
    };
  const setOrders = useCallback(makeSetter('orders', setOrdersLocal, ordersRef), []);
  const setStock = useCallback(makeSetter('stock', setStockLocal, stockRef), []);
  const setStaff = useCallback(makeSetter('staff', setStaffLocal, staffRef), []);
  const setSettings = useCallback(makeSetter('settings', setSettingsLocal, settingsRef), []);
  const setExpenses = useCallback(makeSetter('expenses', setExpensesLocal, expensesRef), []);
  const setAddonPresets = useCallback(makeSetter('addonPresets', setAddonPresetsLocal, addonPresetsRef), []);
  const setMenuPresets = useCallback(makeSetter('menuPresets', setMenuPresetsLocal, menuPresetsRef), []);

  // App UX States
  const [cart, setCart] = useState([]);
  // Who is signed in on this page, and their access level ('owner' | 'staff' |
  // 'inventory')
  // and home shop ('day' | 'night'). All three start empty on every load —
  // nothing is restored, because nothing is stored.
  const [activeStaffUser, setActiveStaffUser] = useState(null);
  const [activeRole, setActiveRole] = useState(null);
  const [activeShop, setActiveShop] = useState(null);
  const [toast, setToast] = useState({ show: false, message: '' });
  const [showPwaModal, setShowPwaModal] = useState(false);
  // Whether the header's profile chip (พนักงาน / ผู้บริหาร) has its menu open.
  // That menu is where ออกจากระบบ lives, so it is only ever opened by those two.
  const [profileOpen, setProfileOpen] = useState(false);
  // The browser's deferred install event (Chrome/Edge/Android fire
  // `beforeinstallprompt` and let us call `.prompt()` on a user gesture). Held
  // in a ref because it is single-use and must survive re-renders untouched;
  // the boolean state below is what the UI actually reacts to.
  const installPromptRef = useRef(null);
  const [canInstall, setCanInstall] = useState(false);
  // True once the app is already running as an installed PWA (standalone /
  // home-screen launch) — no point offering to install it again.
  const [isInstalled, setIsInstalled] = useState(false);

  // Wire up the real "Add to Home Screen" flow. iOS Safari never fires
  // `beforeinstallprompt`, so there `canInstall` stays false and the modal falls
  // back to the manual Share-sheet instructions.
  useEffect(() => {
    const standalone = () =>
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    setIsInstalled(standalone());

    const onBeforeInstall = (e) => {
      e.preventDefault(); // stop Chrome's mini-infobar; we drive the prompt ourselves
      installPromptRef.current = e;
      setCanInstall(true);
    };
    const onInstalled = () => {
      installPromptRef.current = null;
      setCanInstall(false);
      setIsInstalled(true);
      setShowPwaModal(false);
      showToast('ติดตั้งแอปลงหน้าจอโฮมสำเร็จ!');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Status of the very first load of shared state from the backend.
  // 'loading' -> 'ready' | 'error'. Later SSE pushes never revert this.
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');

  // The palette AND which day/night menu is active follow the Bangkok clock and
  // flip live at the 06:00 / 17:00 boundary — no reload needed. The old day/night
  // staff split is gone: staff and owner both ride the clock now (one unified
  // board, see StaffView), instead of being pinned to their account's shop.
  //
  // Customers are left out on purpose: a diner keeps the shift they arrived on
  // (pinned at QR-scan time — see the seating effect below), so their menu and
  // cart never swap out from under them if a meal runs across the boundary.
  useEffect(() => {
    if (role === 'customer') return;
    const sync = () => setTheme((cur) => {
      const now = shiftNow();
      return cur === now ? cur : now;
    });
    sync();
    // A minute's granularity is plenty for a boundary that moves twice a day.
    const timer = setInterval(sync, 60000);
    return () => clearInterval(timer);
  }, [role]);

  // Per-tab UI preferences still live in localStorage (they are NOT shared).
  useEffect(() => {
    localStorage.setItem('activeTheme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('tableNo', tableNo.toString());
  }, [tableNo]);

  useEffect(() => {
    localStorage.setItem('lang', lang);
  }, [lang]);

  // --- ตามบิลที่พนักงานย้ายโต๊ะ ------------------------------------------------
  // A diner's phone is pinned to the table number it scanned, so when staff move
  // the bill (ปุ่ม "ย้ายโต๊ะ" in the edit-bill modal) the order would simply
  // vanish from that phone. Instead the phone follows its own bill to the new
  // number, and the header reads the new table from then on.
  //
  // The match is on bill IDs this phone has actually SEEN open at its own table,
  // not on the bill's `movedFrom` breadcrumb alone. That distinction is the
  // whole safety of it: the next customer seated at the old table has never seen
  // the previous group's bill, so they are never dragged along with it.
  const seenBillsRef = useRef(null);
  const firstSyncRef = useRef(true);
  useEffect(() => {
    // A takeaway phone has no table to be moved away from — it follows its bill
    // by session id wherever staff put it.
    if (role !== 'customer' || takeawaySession) return;
    // Wait for the real orders to arrive. `orders` starts as [] on every load,
    // and resolving against that empty list would forget every remembered bill.
    if (loadState !== 'ready') return;
    if (!seenBillsRef.current) seenBillsRef.current = readSeenBills();

    // The first pass after a (re)load is catching up on a move that already
    // happened, so it re-points the phone silently. Only a move that lands while
    // the diner is looking at the screen is worth announcing.
    const isCatchUp = firstSyncRef.current;
    firstSyncRef.current = false;

    const seen = seenBillsRef.current;
    // The QR's own number, from the seat rather than the URL (which has been
    // cleaned by now — see stripTableParams).
    const scanTable = scanAnchor();

    const before = readTableFollow();
    const { table, follow, moved } = resolveSeating({
      orders,
      currentTable: tableNo,
      scanTable,
      seen,
      follow: before,
    });

    writeSeenBills(seen);
    if (JSON.stringify(follow ?? null) !== JSON.stringify(before ?? null)) writeTableFollow(follow);
    if (Number(table) !== Number(tableNo)) setTableNo(table);
    if (moved && !isCatchUp) showToast(`พนักงานย้ายโต๊ะให้คุณแล้ว — ตอนนี้คือโต๊ะ ${table}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, tableNo, role, loadState]);

  // Load the shared state from the backend, then keep it live over SSE — this is
  // what lets a customer's order appear on the staff tab (and vice-versa) in
  // real time. It re-runs whenever the logged-in user changes (login/logout) so
  // both the fetch and the stream carry the current session token, and the
  // server re-scopes what it returns (an owner then starts receiving the gated
  // expenses/payroll/time-clock data; a logout drops back to the public slice).
  useEffect(() => {
    // Adopt one resource out of a pushed snapshot — but never one this tab is
    // still writing (that snapshot predates our own change), and never one that
    // has not actually changed (see the two refs above).
    const adopt = (resource, value, setLocal, transform) => {
      if (!value) return;
      if (isWriting(resource)) {
        missedPush.current[resource] = true;
        return;
      }
      if (!isNewPayload(resource, value)) return;
      setLocal(transform ? transform(value) : value);
    };
    const applyState = (s) => {
      adopt('orders', s.orders, setOrdersLocal);
      adopt('menu', s.menu, setMenuLocal);
      adopt('stock', s.stock, setStockLocal);
      adopt('staff', s.staff, setStaffLocal);
      adopt('settings', s.settings, setSettingsLocal, (v) => ({ ...DEFAULT_SETTINGS, ...v }));
      adopt('expenses', s.expenses, setExpensesLocal);
      // Normalised rather than spread over the defaults: stored state may still
      // carry the pre-split shape, and a shallow spread would leave the day
      // defaults sitting on top of the real day lists.
      adopt('addons', s.addons, setAddonsLocal, normalizeGroupStore);
      adopt('choices', s.choices, setChoicesLocal, normalizeGroupStore);
      adopt('addonPresets', s.addonPresets, setAddonPresetsLocal);
      adopt('menuPresets', s.menuPresets, setMenuPresetsLocal);
      adopt('timeclock', s.timeclock, setTimeclockLocal);
      adopt('payroll', s.payroll, setPayrollLocal);
    };
    // Reachable from the write path above, which re-reads the state after it has
    // had to ignore a push (see the echo guard).
    applyStateRef.current = applyState;
    fetchState()
      .then((s) => {
        applyState(s);
        setLoadState('ready');
      })
      .catch((err) => {
        console.error('[app] Could not reach backend. Is it running?', err);
        setLoadError(err.message || String(err));
        setLoadState('error');
      });
    // An SSE push means the backend is reachable after all, so a connection
    // that recovers on its own clears the error screen without a reload.
    const unsubscribe = subscribeToState((s) => {
      applyState(s);
      setLoadState('ready');
    });
    return unsubscribe;
  }, [activeStaffUser]);

  // Handle URL table param (?table / ?table-day / ?table-night)
  useEffect(() => {
    const tp = readTableParam();
    if (tp?.takeaway) {
      writeSeat({ takeaway: true });
      stripTableParams();
      setTakeawaySession(takeawaySessionId());
      setRole('customer');
      setTheme(shiftNow());
      showToast('สแกนสั่งกลับบ้านสำเร็จ');
    } else if (tp) {
      // Take the seat, then wipe the link off the address bar. From here on the
      // tab knows where it is sitting without the URL saying so — which is the
      // point: a paid-up diner must not be able to press back, or dig the link
      // out of their browser history, into the ordering page again.
      writeSeat({ table: tp.table, shift: tp.shift });
      stripTableParams();
      // Must go through tableForScan, not tp.table: this effect would otherwise
      // drag a re-seated phone back to the number on its QR every single load.
      setTableNo(tableForScan(tp.table));
      setRole('customer');
      // A QR scan is a fresh customer arrival: an explicit ?table-day /
      // ?table-night link fixes the shift; a plain ?table shows whichever shop
      // is open right now (by the clock) — never a stale theme from a previous
      // session, which could stamp a daytime order onto the night board/bills.
      setTheme(tp.shift || shiftNow());
      const suffix = tp.shift === 'day' ? ' (กลางวัน)' : tp.shift === 'night' ? ' (กลางคืน)' : '';
      showToast(`สแกนเข้าโต๊ะหมายเลข ${tableForScan(tp.table)}${suffix} สำเร็จ`);
    }
  }, []);

  const showToast = (message) => {
    setToast({ show: true, message });
    setTimeout(() => {
      setToast(prev => ({ ...prev, show: false }));
    }, 2800);
  };

  // Land a signed-in session: route to the panel the server says this account
  // belongs to, and nowhere else — so a staff login can't reach the owner board
  // and vice-versa. Shared by an ordinary login and by claiming a password-less
  // account, which signs in the moment the password is chosen.
  //
  // The token stays in memory (api.js put it there); nothing is written to disk,
  // so this session ends with the page.
  const landSession = ({ user: u, name, role: r, shop }) => {
    // Whatever this tab was before, it is a back-office tab now: drop any seat
    // left over from a QR scan so a reload doesn't hand it back to the diner's
    // menu.
    clearSeat();
    const landRole = ['owner', 'inventory'].includes(r) ? r : 'staff';
    const landShop = shop === 'night' ? 'night' : 'day';
    setActiveStaffUser(u);
    setActiveRole(landRole);
    setActiveShop(landShop);
    // Staff and owner both ride the Bangkok clock now (the day/night staff split
    // is gone): land on whatever shift is running, then the auto-switch effect
    // keeps the palette + active menu live at the 06:00 / 17:00 boundary.
    setTheme(shiftNow());
    setRole(landRole);
    showToast(`${name} เข้าสู่ระบบสำเร็จ`);
  };

  // Called by the login page. The backend verifies the password against a hashed
  // store and returns the account's role/shop. Rejects (re-throws) so the login
  // page can show the error inline.
  const handleLogin = async (user, pass) => {
    // Verified server-side; credentials are never checked in the browser.
    const data = await login(user, pass);
    // The owner can create an account without a password. There is no session to
    // land yet — hand the flag back so the login page asks this person to choose
    // one, which is the only way into the account.
    if (data.mustSetPassword) return data;
    landSession(data);
    return data;
  };

  // Second step of that flow: the password the new staff member just chose.
  const handleClaimAccount = async (user, pass) => {
    landSession(await claimAccount(user, pass));
  };

  const handleLogout = () => {
    setProfileOpen(false);
    setActiveStaffUser(null);
    setActiveRole(null);
    setActiveShop(null);
    setAuthToken(null);
    // Back to the front door, NOT the customer menu (that needs a table QR).
    setRole('login');
    showToast('ออกจากระบบแล้ว');
  };

  // Called when the backend rejects a protected write because our session token
  // is missing or expired. Clear the stale session and send back to login.
  const handleSessionExpired = () => {
    setProfileOpen(false);
    setActiveStaffUser(null);
    setActiveRole(null);
    setActiveShop(null);
    setAuthToken(null);
    showToast('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
    setRole('login');
  };

  const triggerPwa = () => {
    setShowPwaModal(true);
  };

  // Fire the browser's native install dialog. Only reachable when
  // `beforeinstallprompt` has been captured (Android/Chrome/Edge); on iOS the
  // button is hidden and the manual steps are shown instead.
  const handleInstall = async () => {
    const promptEvent = installPromptRef.current;
    if (!promptEvent) return;
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    // The event is single-use — a declined prompt can't be re-fired.
    installPromptRef.current = null;
    setCanInstall(false);
    if (outcome === 'accepted') {
      setShowPwaModal(false);
      // `appinstalled` also fires and toasts, but that can lag; acknowledge now.
    } else {
      showToast('ยกเลิกการติดตั้ง');
    }
  };

  // A takeaway phone's header names its bill once it has one (กลับบ้าน #3), and
  // just the channel before the first order.
  const takeawayBill = takeawaySession ? orders[takeawayBillIndex(orders, takeawaySession)] : null;
  const takeawayHeader = takeawaySession
    ? (takeawayBill ? tableLabel(takeawayBill.table) : 'กลับบ้าน')
    : null;

  // The panels that get a desktop-width layout (see the shell below).
  const isBackOffice = role === 'staff' || role === 'owner' || role === 'inventory';

  return (
    <div
      className={`min-h-screen transition-colors duration-500 flex flex-col ${theme === 'day' ? 'theme-day' : 'theme-night'}`}
    >

      {/* GLOBAL TOAST */}
      <div className={`fixed bottom-20 left-1/2 transform -translate-x-1/2 bg-neutral-900/95 dark:bg-[#2E251C]/95 text-white text-xs px-4 py-2.5 rounded-full shadow-xl z-[200] transition-all duration-300 pointer-events-none flex items-center gap-2 ${toast.show ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-90'}`}>
        <span>ℹ️</span>
        <span className="font-medium font-thai">{toast.message}</span>
      </div>

      {/* CORE SHELL — a phone-width column by default. The back office (พนักงาน /
          ผู้บริหาร) is the part actually opened on a desktop or a counter tablet,
          so those two widen with the screen instead of leaving a 448px strip in
          the middle of a monitor. The diner's menu keeps the phone shape: it is
          reached by scanning a QR at the table, which is a phone by definition. */}
      <div className={`flex flex-col flex-1 w-full mx-auto shadow-2xl relative overflow-hidden transition-all duration-500 min-h-screen text-ink ${isBackOffice ? 'ui-desktop-scale max-w-md lg:max-w-4xl xl:max-w-6xl' : 'max-w-md'} ${theme === 'day' ? 'surface-cozy' : 'bg-app border-x border-line'}`}>

        {/* TOP NAVBAR */}
        <header className={`px-3.5 py-3 flex items-center justify-between gap-3 transition-colors duration-500 shadow-md text-header-ink ${theme === 'day' ? 'wood-grain' : 'border-b border-line bg-strip'}`}>
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm overflow-hidden bg-logo ${theme === 'day' ? 'ring-1 ring-black/10' : 'ring-1 ring-line-strong text-accent'}`}>
              {theme === 'day' ? (
                <img src={logoImg} alt="ตู้กับข้าวบ้านยาย" className="w-full h-full object-cover" />
              ) : (
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M22 3H2l10 10V21" />
                  <line x1="6" y1="21" x2="18" y2="21" />
                  <line x1="3" y1="5" x2="21" y2="5" />
                </svg>
              )}
            </span>
            <h1
              className={`font-kanit font-bold tracking-wide leading-none select-none truncate text-xl ${theme === 'day' ? '[text-shadow:0_1px_3px_rgba(60,30,10,0.55)]' : ''}`}
            >
              {/* Saved settings predate nameNight, so fall back to the default
                  rather than rendering an empty header. */}
              {theme === 'day'
                ? settings.name
                : (settings.nameNight || DEFAULT_SETTINGS.nameNight)}
            </h1>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Menu language toggle — shown only to diners, since the menu is
                the only thing translated. Flips the whole customer menu between
                Thai and English. */}
            {role === 'customer' && (
              <button
                onClick={() => setLang(prev => (prev === 'th' ? 'en' : 'th'))}
                className={`h-10 px-3 rounded-full flex items-center justify-center gap-1 font-kanit font-bold text-sm transition-all duration-300 shadow-sm bg-raised hover:bg-raised-hover text-raised-ink ${theme === 'day' ? '' : 'border border-line-strong'}`}
                title="เปลี่ยนภาษา / Change language"
              >
                <Languages className="w-4 h-4" />
                <span>{lang === 'th' ? 'EN' : 'ไทย'}</span>
              </button>
            )}

            {/* The old owner day/night toggle is gone: the palette (and which
                day/night menu is active) now follows the Bangkok clock for
                everyone and flips automatically at 06:00 / 17:00. */}

            {/* Role badge. There is intentionally no panel switcher: which panel
                you see is fixed by how you arrived (QR scan → customer, or the
                account you logged in as → staff / owner).

                For staff/owner the badge doubles as the profile button — tapping
                it drops down who you are signed in as and ออกจากระบบ. A customer's
                โต๊ะ N badge has nothing to open, so it stays a plain label. */}
            {role !== 'login' && (
              <div className="relative flex-shrink-0">
                {role === 'customer' ? (
                  <div
                    className={`flex items-center gap-1.5 rounded-full font-kanit font-semibold tracking-wide bg-raised ${theme === 'day' ? 'text-raised-ink text-base px-5 py-2 shadow-sm' : 'border border-line-strong text-ink text-sm px-4 py-2'}`}
                  >
                    <span>{takeawayHeader ?? `โต๊ะ ${tableNo}`}</span>
                  </div>
                ) : (
                  <button
                    onClick={() => setProfileOpen((open) => !open)}
                    aria-haspopup="menu"
                    aria-expanded={profileOpen}
                    title="โปรไฟล์ / ออกจากระบบ"
                    className={`flex items-center gap-1.5 rounded-full font-kanit font-semibold tracking-wide bg-raised hover:bg-raised-hover transition-colors ${theme === 'day' ? 'text-raised-ink text-base px-5 py-2 shadow-sm' : 'border border-line-strong text-ink text-sm px-4 py-2'}`}
                  >
                    {role === 'staff' ? (
                      <>
                        <ShieldCheck className="w-3.5 h-3.5 text-accent" />
                        <span>พนักงาน</span>
                      </>
                    ) : role === 'inventory' ? (
                      <>
                        <Package className="w-3.5 h-3.5 text-accent" />
                        <span>ผู้จัดการคลัง</span>
                      </>
                    ) : (
                      <>
                        <Key className="w-3.5 h-3.5 text-accent" />
                        <span>ผู้บริหาร</span>
                      </>
                    )}
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${profileOpen ? 'rotate-180' : ''}`} />
                  </button>
                )}

                {/* PROFILE MENU — anchored under the badge. The transparent sheet
                    behind it turns any tap elsewhere into "close". */}
                {profileOpen && role !== 'customer' && (
                  <>
                    <div className="fixed inset-0 z-[90]" onClick={() => setProfileOpen(false)} />
                    <div className="absolute right-0 top-full mt-2 w-56 z-[95] bg-admin-card text-neutral-800 rounded-2xl shadow-2xl border border-neutral-100 p-3 space-y-2.5 font-thai animate-slide-up">
                      <div className="px-1">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">ล็อกอินเป็น</span>
                        <span className="font-bold text-sm text-neutral-800 break-all">{activeStaffUser}</span>
                        <span className="text-[10px] text-neutral-400 block">
                          {role === 'owner' ? 'ผู้บริหาร' : role === 'inventory' ? 'ผู้จัดการคลัง' : 'พนักงาน'}
                        </span>
                      </div>
                      <button
                        onClick={() => { setProfileOpen(false); handleLogout(); }}
                        className="w-full flex items-center justify-center gap-1.5 bg-red-500 hover:bg-red-600 text-white font-bold py-2.5 rounded-xl transition-colors text-xs"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        <span>ออกจากระบบ</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </header>

        {/* MAIN BODY LAYOUT */}
        <main className={`flex-1 overflow-y-auto ${role === 'login' ? 'flex flex-col' : 'p-4 space-y-4'}`}>
          {/* The front door for staff/owner. Shown regardless of menu load state
              — it doesn't need the menu, and the backend has to be up to log in
              anyway (a failure surfaces inline on the form). */}
          {role === 'login' && (
            <LoginPage onLogin={handleLogin} onClaimAccount={handleClaimAccount} settings={settings} />
          )}

          {/* First-load states. Once state has arrived these never show again,
              so live SSE updates don't flash a spinner over the menu. */}
          {role !== 'login' && loadState === 'loading' && (
            <div className="py-16 text-center space-y-3 font-thai">
              <div className="w-8 h-8 mx-auto rounded-full border-2 border-[#A9713D]/25 border-t-[#A9713D] animate-spin" />
              <p className="text-xs text-neutral-400 font-medium">กำลังโหลดเมนูจาก Google Sheets...</p>
            </div>
          )}

          {role !== 'login' && loadState === 'error' && (
            <div className="py-12 px-4 text-center space-y-3 font-thai">
              <span className="text-3xl">📡</span>
              <h3 className="font-kanit font-bold text-sm text-[#5A2E14]">โหลดข้อมูลไม่สำเร็จ</h3>
              <p className="text-xs text-neutral-500 leading-relaxed">
                ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ของร้านได้ กรุณาตรวจสอบว่าเปิดระบบหลังบ้านอยู่ แล้วลองใหม่อีกครั้ง
              </p>
              {loadError && (
                <p className="text-[10px] text-neutral-400 font-mono break-all bg-neutral-100 rounded-lg p-2">
                  {loadError}
                </p>
              )}
              <button
                onClick={() => window.location.reload()}
                className="text-xs bg-[#A9713D] hover:bg-[#8A5A32] text-white font-bold py-2.5 px-5 rounded-xl transition"
              >
                ลองใหม่อีกครั้ง
              </button>
            </div>
          )}

          {role !== 'login' && loadState === 'ready' && menu.length === 0 && (
            <div className="py-16 text-center space-y-2 font-thai">
              <span className="text-3xl">🍽️</span>
              <h3 className="font-kanit font-bold text-sm text-[#5A2E14]">ยังไม่มีรายการอาหาร</h3>
              <p className="text-xs text-neutral-400">ยังไม่มีเมนูในระบบขณะนี้ กรุณาติดต่อพนักงาน</p>
            </div>
          )}

          {loadState === 'ready' && menu.length > 0 && role === 'customer' && (
            <CustomerView
              theme={theme}
              lang={lang}
              tableNo={tableNo}
              takeawaySession={takeawaySession}
              menu={menu}
              orders={orders}
              setOrders={setOrders}
              stock={stock}
              setStock={setStock}
              cart={cart}
              setCart={setCart}
              addons={addons}
              choices={choices}
              addonPresets={addonPresets}
              showToast={showToast}
            />
          )}

          {loadState === 'ready' && role === 'staff' && (
            <StaffView
              theme={theme} 
              menu={menu} 
              orders={orders}
              setOrders={setOrders}
              stock={stock}
              setStock={setStock}
              settings={settings}
              activeStaffUser={activeStaffUser}
              showToast={showToast}
              addons={addons}
              choices={choices}
              addonPresets={addonPresets}
              timeclock={timeclock}
            />
          )}

          {/* ผู้จัดการคลัง: คลัง + จัดการเมนู (stocked dishes only), nothing else. */}
          {loadState === 'ready' && role === 'inventory' && (
            <InventoryView
              menu={menu}
              addonPresets={addonPresets}
              setAddonPresets={setAddonPresets}
              showToast={showToast}
            />
          )}

          {loadState === 'ready' && role === 'owner' && (
            <OwnerView
              menu={menu}
              addonPresets={addonPresets}
              setAddonPresets={setAddonPresets}
              menuPresets={menuPresets}
              setMenuPresets={setMenuPresets}
              expenses={expenses}
              setExpenses={setExpenses}
              orders={orders}
              settings={settings}
              setSettings={setSettings}
              staff={staff}
              setStaff={setStaff}
              showToast={showToast}
              timeclock={timeclock}
              payroll={payroll}
              activeStaffUser={activeStaffUser}
            />
          )}
        </main>

        {/* The old bottom logout strip lived here. Both it and the "ล็อกอินเป็น"
            line now sit in the header's profile menu, so the panels get that
            row of screen back. */}

        {/* FOOTER */}
        <footer className="text-[10px] text-center py-2 border-t font-thai transition-colors duration-500 border-line bg-strip text-ink-3">
          ระบบร้านค้าอัจฉริยะ &bull; <button onClick={triggerPwa} className="underline hover:text-amber-500 font-bold focus:outline-none">ติดตั้งแอปรวม (PWA)</button>
        </footer>
      </div>

      {/* PWA MOCKUP MODAL */}
      {showPwaModal && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-admin-card rounded-2xl max-w-xs w-full p-6 text-center space-y-4 text-neutral-800 shadow-2xl">
            <div className="mx-auto w-14 h-14 bg-amber-500/10 rounded-2xl flex items-center justify-center text-amber-600 dark:text-amber-300 shadow-inner">
              <Smartphone className="w-8 h-8" />
            </div>
            <div>
              <h3 className="font-extrabold text-base font-kanit">เพิ่มไปยังหน้าจอหลัก (PWA)</h3>
              <p className="text-xs text-neutral-500 font-thai leading-snug mt-1">
                {isInstalled
                  ? 'แอปนี้ถูกติดตั้งบนหน้าจอโฮมเรียบร้อยแล้ว เปิดใช้งานได้จากไอคอนแอปได้เลย'
                  : 'ติดตั้งแอปสั่งอาหารไว้บนหน้าจอมือถือของคุณเพื่อสแกนสั่งครั้งต่อๆ ไปอย่างรวดเร็วโดยไม่ต้องค้นหาเว็บ'}
              </p>
            </div>

            {/* When the browser gives us a real install prompt (Android/Chrome/
                Edge) a single "ติดตั้งเลย" tap does the whole thing. Otherwise —
                iOS Safari, or a desktop that can't install — we fall back to the
                manual per-OS steps. */}
            {!isInstalled && !canInstall && (
              <div className="bg-neutral-50 rounded-xl p-3 text-left space-y-1.5 text-[11px] font-thai text-neutral-600">
                <div><span className="font-bold text-neutral-800">ระบบปฏิบัติการ Android:</span> กดปุ่มขีดสามขีดหรือเมนูมุมขวา เลือกหัวข้อ "เพิ่มไปยังหน้าจอหลัก"</div>
                <div className="border-t border-neutral-100 pt-1.5"><span className="font-bold text-neutral-800">ระบบปฏิบัติการ iOS (Safari):</span> กดปุ่มแชร์รูปกล่องมีลูกศรชี้ขึ้นที่แถบนำทางล่าง แล้วเลือกเมนู "เพิ่มไปยังหน้าจอโฮม"</div>
              </div>
            )}

            <div className="flex gap-2 pt-1 font-thai text-xs">
              <button
                onClick={() => setShowPwaModal(false)}
                className="flex-1 bg-neutral-100 hover:bg-neutral-200 font-bold py-2 rounded-xl transition text-neutral-700"
              >
                ปิด
              </button>
              {canInstall && !isInstalled && (
                <button
                  onClick={handleInstall}
                  className="flex-1 bg-amber-600 hover:bg-amber-700 font-bold py-2 rounded-xl transition text-white"
                >
                  ติดตั้งเลย
                </button>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
