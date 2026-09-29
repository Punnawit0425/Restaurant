import React, { useState, useMemo, useEffect } from 'react';
import {
  Trash2,
  Settings as SettingsIcon,
  Wallet,
  LayoutDashboard,
  UtensilsCrossed,
  CalendarClock,
  UserCog,
  Users,
  Package,
  RotateCcw
} from 'lucide-react';
import OwnerDashboard from './OwnerDashboard';
import OwnerSummary from './OwnerSummary';
import OwnerMenu from './OwnerMenu';
import OwnerBills from './OwnerBills';
import StockPanel from './StockPanel';
import TableQrCodes from './TableQrCodes';
import { manualTimeclock, setPayrollStatus, updateStaffAccount, fetchStockHistory } from '../api';
import { STOCK_ACTION_LABELS, STOCK_ACTION_COLORS, fmtStockTime } from '../stock-history';
import { workdayKey } from '../shift';
import {
  SHOPS,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  formatThaiDate,
  roundBaht,
  formatBaht
} from '../expenses';

// สิทธิ์การเข้าถึง — shared by the เพิ่มพนักงานใหม่ form and แก้ไขข้อมูลพนักงาน, so the
// two can never offer different choices. The label says what each one sees.
const ROLE_OPTIONS = [
  { value: 'staff', label: 'พนักงาน (เห็นเฉพาะบอร์ดรับออเดอร์)' },
  { value: 'owner', label: 'เจ้าของ/ผู้บริหาร (เข้าหลังบ้านได้)' },
  { value: 'inventory', label: 'ผู้จัดการคลัง (เห็นเฉพาะหน้าคลังและจัดการเมนูในคลัง)' },
];
const roleLabel = (role) =>
  role === 'owner' ? 'ผู้บริหาร' : role === 'inventory' ? 'ผู้จัดการคลัง' : 'พนักงาน';

function OwnerView({
  menu,
  addonPresets,
  setAddonPresets,
  menuPresets,
  setMenuPresets,
  orders,
  expenses,
  setExpenses,
  settings,
  setSettings,
  staff,
  setStaff,
  showToast,
  timeclock,
  payroll,
  activeStaffUser
}) {
  const [subTab, setSubTab] = useState('dashboard'); // dashboard, menu, stock, finance, timeclock, settings

  // --- LEDGER ENTRY FORM (รายรับ / รายจ่าย) ---
  // Which side of the book the form is writing to. Defaults to รายจ่าย: takings
  // arrive through the bills on their own, so an outgoing is what the owner is
  // nearly always here to type.
  const [entryType, setEntryType] = useState('expense'); // expense | income
  const [expShop, setExpShop] = useState(SHOPS[0].id);
  // One category per side, kept apart so flipping the switch back and forth
  // never loses the choice already made on the other side.
  const [expCategory, setExpCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [incCategory, setIncCategory] = useState(INCOME_CATEGORIES[0]);
  const [expAmount, setExpAmount] = useState('');
  const [expNote, setExpNote] = useState('');
  // The day a new expense is filed under. Defaults to the working day in
  // progress — the 06:00-based one the takings are counted on, so a bottle of
  // gas bought at 01:00 lands on the night that used it, not on tomorrow. Any
  // date can still be picked: back-dating a receipt found later, or
  // forward-dating one paid ahead (rent, a deposit) into the month it belongs to.
  const [expDate, setExpDate] = useState(() => workdayKey());
  // Which month the ledger below the form is showing ('YYYY-MM'). It lives here,
  // not in OwnerSummary, so filing an expense dated into another month can jump
  // the table to it — otherwise the owner saves a receipt and sees nothing.
  const [ledgerMonth, setLedgerMonth] = useState(() => workdayKey().slice(0, 7));

  // Form states for staff accounts
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffUser, setNewStaffUser] = useState('');
  const [newStaffPass, setNewStaffPass] = useState('');
  // ไอดีพนักงาน — the 4-digit code this person types to sign a printed bill or a
  // discount. Set by the owner here; the server stores only its hash and never
  // sends it back, so it is write-only from this screen onwards.
  const [newStaffPin, setNewStaffPin] = useState('');
  // ตำแหน่ง + ค่าแรงรายวัน + ร้านที่ประจำ ('day' | 'night') — owner-only info,
  // shown nowhere outside this settings panel.
  const [newStaffPosition, setNewStaffPosition] = useState('');
  const [newStaffWage, setNewStaffWage] = useState('');
  const [newStaffShop, setNewStaffShop] = useState('day');
  // Access level: 'staff' (พนักงาน — shift board only) | 'owner' (เจ้าของ —
  // this back office). Defaults to staff so owner access is always deliberate.
  const [newStaffRole, setNewStaffRole] = useState('staff');

  // --- ประวัติเข้างาน (time clock history) ---
  // Which month the summary table shows (YYYY-MM) and which day the in/out
  // detail table shows (YYYY-MM-DD). Both default to the current WORKING day
  // (06:00 → 06:00), which is how staff records are keyed — at 01:00 the owner
  // must land on the shift still in progress, not on an empty new date.
  const [tcMonth, setTcMonth] = useState(() => workdayKey().slice(0, 7));
  const [tcDate, setTcDate] = useState(() => workdayKey());

  // Backfill modal (admin logs a forgotten clock). null = closed.
  const [backfill, setBackfill] = useState(null); // { user, date, inTime, outTime }
  const [savingClock, setSavingClock] = useState(false);

  // Staff editor modal (ชื่อ / ชื่อผู้ใช้ / รหัสผ่าน / ค่าแรง). null = closed.
  // `original` is the username the account is stored under, kept separate from
  // the editable `user` field so a rename knows which record to patch.
  const [staffEdit, setStaffEdit] = useState(null);
  const [savingStaff, setSavingStaff] = useState(false);

  // Settings form draft. The fields edit this LOCAL copy and only commit to the
  // shared state (which POSTs + broadcasts over SSE) when the form is saved.
  //
  // The draft is re-seeded ONLY when the owner opens the ตั้งค่า tab — never on
  // every `settings` change. That distinction is the whole fix: the backend
  // rebroadcasts the FULL state (orders, stock, settings, everything) to every
  // client on ANY change, and `applyState` builds a brand-new `settings` object
  // each time even when its values are identical. A busy shop fires those
  // broadcasts constantly, so re-seeding on `[settings]` would wipe the field
  // mid-typing on every order — silent on an idle localhost, a live character
  // flicker on a deployed, in-use shop.
  const [settingsDraft, setSettingsDraft] = useState(settings);
  useEffect(() => {
    // Only [subTab] on purpose: a broadcast that arrives while the owner is
    // typing on this tab must NOT overwrite the draft. Re-entering the tab picks
    // up the latest committed values.
    if (subTab === 'settings') setSettingsDraft(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab]);

  // --- ตารางที่ 3: ประวัติอัปเดตสต็อก ------------------------------------------
  // The stock_history audit trail (who moved what, when). It lives in PostgreSQL
  // rather than the shared app state, so it is fetched on demand instead of
  // arriving over SSE — hence its own loading/error pair and a refresh button.
  const [stockHistory, setStockHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  const loadStockHistory = async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      setStockHistory(await fetchStockHistory(200));
    } catch (err) {
      setHistoryError(err.message || 'โหลดประวัติอัปเดตสต็อกไม่สำเร็จ');
    } finally {
      setHistoryLoading(false);
    }
  };

  // Load once the tab is actually opened, so the other four tabs cost nothing.
  useEffect(() => {
    if (subTab === 'timeclock') loadStockHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab]);

  // Days worked (and wages owed) per staff member in the chosen month. A day
  // counts ONLY when it has BOTH a clock-in and a clock-out — hours don't
  // matter (they're only for spotting a late arrival). Staff with no records
  // still get a row showing 0.
  //
  // Owner accounts are left out: the เจ้าของร้าน IS the one paying, so a
  // "เงินเดือน / ยังไม่จ่าย" row against themselves is money owed to nobody —
  // and marking it จ่ายแล้ว would file a wage into their own รายจ่าย. Their
  // clock-ins still show in ตารางที่ 2, which is attendance, not payroll.
  const tcMonthlySummary = useMemo(() => {
    const monthRecords = (timeclock || []).filter((r) => (r.date || '').startsWith(tcMonth));
    return (staff || []).filter((s) => s.role !== 'owner').map((s) => {
      const days = new Set(
        monthRecords.filter((r) => r.user === s.user && r.inAt && r.outAt).map((r) => r.date)
      ).size;
      const paid = payroll?.[`${s.user}__${tcMonth}`] === 'paid';
      return {
        user: s.user, name: s.name, position: s.position,
        // Which shop the wage is an expense OF, when marking the month paid
        // files it in the ledger.
        shop: s.shop || 'day',
        dailyWage: s.dailyWage || 0, days, salary: days * (s.dailyWage || 0), paid,
      };
    });
  }, [timeclock, staff, tcMonth, payroll]);

  // The chosen day flattened into ONE row per event (a clock-in and a clock-out
  // are separate rows), sorted by the actual time — matching the daily ticket.
  const tcDayEvents = useMemo(() => {
    const events = [];
    (timeclock || [])
      .filter((r) => r.date === tcDate)
      .forEach((r) => {
        if (r.inAt) events.push({ id: r.id + '-in', at: r.inAt, name: r.name || r.user, kind: 'in' });
        if (r.outAt) events.push({ id: r.id + '-out', at: r.outAt, name: r.name || r.user, kind: 'out' });
      });
    return events.sort((a, b) => a.at - b.at);
  }, [timeclock, tcDate]);

  const tcTime = (ts) =>
    ts ? new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' น.' : '—';

  // Combine the modal's date (YYYY-MM-DD) + a "HH:MM" time into epoch ms.
  const combineDateTime = (date, time) =>
    time ? new Date(`${date}T${time}:00`).getTime() : null;

  // --- เงินเดือนที่จ่ายแล้ว -> รายจ่าย ----------------------------------------
  // Marking a month "จ่ายแล้ว" files the wage in the expense book by itself: the
  // money left the till at that moment, and an owner who has to remember to type
  // it in again is an owner whose รายรับ-รายจ่าย is quietly wrong.
  //
  // The id is derived from (user, month) rather than random, which is what makes
  // the entry findable again: switching the status back to ยังไม่จ่าย pulls the
  // same row out, and marking paid twice overwrites rather than double-files.
  const payrollExpenseId = (user, month) => `exp_payroll_${user}_${month}`;

  // Which day the wage is filed under. Paying the current month files it today;
  // settling an earlier month files it on that month's last day, so the cost
  // always lands in the month it was earned rather than the month it was
  // remembered.
  const payrollExpenseDate = (month) => {
    const today = workdayKey();
    if (today.slice(0, 7) === month) return today;
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
    return `${month}-${String(lastDay).padStart(2, '0')}`;
  };

  const handleTogglePaid = async (row) => {
    const next = row.paid ? 'unpaid' : 'paid';

    // Confirm both directions before touching anything: marking จ่ายแล้ว files a
    // wage in the expense book, switching back to ยังไม่จ่าย pulls it out again —
    // neither should fire on a stray tap.
    const ok = next === 'paid'
      ? confirm(row.salary > 0
          ? `ยืนยันจ่ายเงินเดือน ${row.name} จำนวน ${row.salary.toLocaleString()} บาท (เดือน ${tcMonth}) แล้วใช่หรือไม่?`
          : `ยืนยันทำเครื่องหมายว่าจ่ายเงินเดือน ${row.name} (เดือน ${tcMonth}) แล้วใช่หรือไม่?`)
      : confirm(`ยืนยันเปลี่ยนสถานะ ${row.name} กลับเป็น "ยังไม่จ่าย" (เดือน ${tcMonth}) ใช่หรือไม่?`);
    if (!ok) return;

    const id = payrollExpenseId(row.user, tcMonth);
    try {
      await setPayrollStatus({ user: row.user, month: tcMonth, status: next });

      if (next === 'unpaid') {
        const filed = (expenses || []).some((e) => e.id === id);
        setExpenses((prev) => (prev || []).filter((e) => e.id !== id));
        showToast(filed
          ? `ยกเลิกการจ่าย: ${row.name} — ลบรายจ่ายที่บันทึกไว้แล้ว`
          : `ยกเลิกการจ่าย: ${row.name}`);
        return;
      }

      // Nothing earned, nothing to file — but the owner may still want the month
      // flagged as settled (paid in cash, no recorded days), so the status stands
      // and only the expense is skipped.
      if (!(row.salary > 0)) {
        showToast(`ทำเครื่องหมายจ่ายแล้ว: ${row.name} (ยังไม่มียอดให้บันทึกเป็นรายจ่าย)`);
        return;
      }

      const entry = {
        id,
        date: payrollExpenseDate(tcMonth),
        shop: row.shop,
        kind: 'expense',
        category: 'ค่าแรงพนักงาน',
        amount: row.salary,
        note: `เงินเดือน ${row.name} เดือน ${tcMonth} (${row.days} วัน × ${row.dailyWage.toLocaleString()} บาท)`,
        // Marks the row as filed by the payroll switch rather than typed by hand.
        source: 'payroll',
        createdAt: Date.now(),
      };
      setExpenses((prev) => [...(prev || []).filter((e) => e.id !== id), entry]);
      setLedgerMonth(entry.date.slice(0, 7));
      showToast(`จ่ายเงินเดือน ${row.name} ${row.salary.toLocaleString()} บาท — บันทึกลงรายจ่ายให้แล้ว`);
    } catch (err) {
      showToast(err.message || 'อัปเดตสถานะไม่สำเร็จ');
    }
  };

  const openBackfill = () => {
    setBackfill({ user: staff?.[0]?.user || '', date: tcDate, inTime: '', outTime: '' });
  };

  // --- แก้ไขข้อมูลพนักงาน ------------------------------------------------------
  // Load one account into the editor. The password box always opens EMPTY: the
  // server never sends a password back (only a hash it keeps to itself), and a
  // box pre-filled with dots would suggest the real one is sitting there to be
  // read. Blank means "leave it as it is".
  const loadStaffEdit = (user) => {
    const s = (staff || []).find((a) => a.user === user);
    if (!s) return null;
    return {
      original: s.user,
      user: s.user,
      name: s.name || '',
      pass: '',
      // Same rule as the password box: blank = keep the stored code. Unlike the
      // password, the current code IS readable (owner sessions are sent it), so
      // it is shown next to the box rather than typed back into it — a pre-filled
      // box would be re-saved as a "change" on every edit.
      pin: '',
      currentPin: s.pin || '',
      hasPin: !!s.hasPin,
      // false only when the server explicitly said so — an older payload without
      // the field must not be read as "no password".
      hasPass: s.hasPass !== false,
      role: s.role || 'staff',
      originalRole: s.role || 'staff',
      dailyWage: s.dailyWage ? String(s.dailyWage) : '',
    };
  };

  const openStaffEdit = () => {
    const first = staff?.[0]?.user;
    if (!first) return showToast('ยังไม่มีบัญชีพนักงานในระบบ');
    setStaffEdit(loadStaffEdit(first));
  };

  const handleSaveStaffEdit = async () => {
    if (!staffEdit || savingStaff) return;
    const user = staffEdit.user.trim();
    const name = staffEdit.name.trim();
    if (!user) return showToast('กรุณากรอกชื่อผู้ใช้');
    if (staffEdit.dailyWage !== '' && !(Number(staffEdit.dailyWage) >= 0)) {
      return showToast('ค่าแรงต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
    }
    if (user !== staffEdit.original && (staff || []).some((s) => s.user === user)) {
      return showToast('มีชื่อผู้ใช้งานนี้ในระบบแล้ว');
    }
    if (staffEdit.pin && !/^\d{4}$/.test(staffEdit.pin)) {
      return showToast('ไอดีพนักงานต้องเป็นตัวเลข 4 หลัก');
    }

    setSavingStaff(true);
    try {
      await updateStaffAccount(staffEdit.original, {
        user,
        name,
        // Only sent when the owner typed one — an empty string would be read as
        // a request to blank the password.
        ...(staffEdit.pass ? { pass: staffEdit.pass } : {}),
        ...(staffEdit.pin ? { pin: staffEdit.pin } : {}),
        // An owner is never on the payroll, so their wage stays pinned at 0
        // rather than carrying whatever an older record happened to hold.
        dailyWage: staffEdit.role === 'owner' ? 0 : staffEdit.dailyWage,
        role: staffEdit.role,
      });
      // No local staff write: the server rewrites the account (and moves the
      // person's attendance history if the username changed), then pushes the
      // new state to every open tab over SSE.
      showToast(
        `แก้ไขข้อมูล ${name || user} เรียบร้อย` +
        (staffEdit.pass ? ' (เปลี่ยนรหัสผ่านแล้ว)' : '') +
        (staffEdit.pin ? ' (ตั้งไอดีใหม่แล้ว)' : '') +
        (staffEdit.role !== staffEdit.originalRole ? ` (สิทธิ์ใหม่: ${roleLabel(staffEdit.role)})` : '')
      );
      setStaffEdit(null);
    } catch (err) {
      showToast(err.message || 'แก้ไขข้อมูลพนักงานไม่สำเร็จ');
    } finally {
      setSavingStaff(false);
    }
  };

  const handleSaveBackfill = async () => {
    if (!backfill?.user || !backfill?.date) return;
    if (!backfill.inTime && !backfill.outTime) {
      showToast('กรุณาระบุเวลาเข้าหรือออกอย่างน้อยหนึ่งช่อง');
      return;
    }
    setSavingClock(true);
    try {
      await manualTimeclock({
        user: backfill.user,
        date: backfill.date,
        inAt: combineDateTime(backfill.date, backfill.inTime),
        outAt: combineDateTime(backfill.date, backfill.outTime),
      });
      showToast('บันทึกเวลาย้อนหลังเรียบร้อย');
      setBackfill(null);
    } catch (err) {
      showToast(err.message || 'บันทึกเวลาย้อนหลังไม่สำเร็จ');
    } finally {
      setSavingClock(false);
    }
  };


  // --- LEDGER ACTIONS ---
  // Both sides of the book are written here and stored in the same `expenses`
  // list; `kind` is what tells them apart everywhere downstream.
  const isIncomeEntry = entryType === 'income';
  const entryCategory = isIncomeEntry ? incCategory : expCategory;
  const entryWord = isIncomeEntry ? 'รายรับ' : 'รายจ่าย';

  const handleAddEntry = (e) => {
    e.preventDefault();
    const amountNum = roundBaht(parseFloat(expAmount));
    if (!(amountNum > 0)) {
      alert('กรุณากรอกจำนวนเงินให้ถูกต้อง');
      return;
    }

    const entry = {
      id: (isIncomeEntry ? 'inc_' : 'exp_') + Date.now().toString(36),
      date: expDate || workdayKey(),
      shop: expShop,
      // Written on every new row, income or not, so the book stops relying on
      // "no kind means outgoing" as soon as these entries exist.
      kind: isIncomeEntry ? 'income' : 'expense',
      category: entryCategory,
      amount: amountNum,
      note: expNote.trim(),
      createdAt: Date.now()
    };

    setExpenses((prev) => [...(prev || []), entry]);
    // Jump the ledger to the month we just filed under, so the new row is visible.
    setLedgerMonth(entry.date.slice(0, 7));
    setExpAmount('');
    setExpNote('');
    showToast(
      `บันทึก${entryWord} ${formatBaht(amountNum)} บาท (${entryCategory}) วันที่ ${formatThaiDate(entry.date)} แล้ว`
    );
  };

  // `kind` comes from the ledger row, so the wording matches what was clicked.
  // Rolled-up bill income has no id and never reaches here.
  const handleDeleteEntry = (id, category, amount, kind) => {
    const word = kind === 'income' ? 'รายรับ' : 'รายจ่าย';
    if (confirm(`ลบ${word} [${category} ${formatBaht(amount)} บาท] ใช่หรือไม่?`)) {
      setExpenses((prev) => (prev || []).filter((e) => e.id !== id));
      showToast(`ลบรายการ${word}แล้ว`);
    }
  };

  // --- SETTINGS FORM ACTIONS ---
  const handleSaveSettings = (e) => {
    e.preventDefault();
    // Commit the local draft once — the single write that reaches the backend.
    setSettings(settingsDraft);
    showToast('บันทึกข้อมูลการตั้งค่าเสร็จสมบูรณ์');
  };

  const handleAddStaffAccount = (e) => {
    e.preventDefault();
    // The password is optional: leaving it blank creates the account without one
    // and the staff member chooses their own the first time they sign in. The
    // username is not — it is how they identify themselves at that first login.
    if (!newStaffUser.trim()) {
      alert('กรุณากรอกชื่อผู้ใช้งานของพนักงาน');
      return;
    }
    if (staff.some(s => s.user === newStaffUser)) {
      alert('มีชื่อผู้ใช้งานนี้ในระบบแล้ว');
      return;
    }
    // The PIN is what puts this person's name on a bill they print, so it is
    // required at creation rather than left to be filled in later. The server
    // checks the format and rejects a code somebody else already holds.
    if (!/^\d{4}$/.test(newStaffPin.trim())) {
      alert('กรุณากรอกไอดีพนักงานเป็นตัวเลข 4 หลัก (เช่น 2580)');
      return;
    }

    const newAcc = {
      user: newStaffUser.trim(),
      // Omitted entirely when blank, which is what the server reads as "no
      // password yet" — sending '' would look like a password of zero length.
      ...(newStaffPass ? { pass: newStaffPass } : {}),
      pin: newStaffPin.trim(),
      name: newStaffName.trim() || newStaffUser.trim(),
      position: newStaffPosition.trim(),
      // Daily wage in THB — numeric so payroll sums can be computed later.
      dailyWage: Math.max(0, parseFloat(newStaffWage) || 0),
      // Which shop this person works at: 'day' (ตู้กับข้าวบ้านยาย) | 'night' (เรือนเก่า)
      shop: newStaffShop,
      // Access level decides which panel their login lands on.
      role: newStaffRole
    };

    setStaff(prev => [...prev, newAcc]);
    setNewStaffName('');
    setNewStaffUser('');
    setNewStaffPass('');
    setNewStaffPin('');
    setNewStaffPosition('');
    setNewStaffWage('');
    setNewStaffShop('day');
    setNewStaffRole('staff');
    showToast(
      newAcc.pass
        ? `เพิ่มพนักงาน [${newAcc.name}] เข้าระบบแล้ว`
        : `เพิ่มพนักงาน [${newAcc.name}] แล้ว — ให้ตั้งรหัสผ่านเองตอนเข้าระบบครั้งแรก`
    );
  };

  const handleDeleteStaffAccount = (username) => {
    if (staff.length <= 1) {
      alert('ไม่สามารถลบพนักงานบัญชีสุดท้ายได้ ระบบต้องการอย่างน้อย 1 บัญชีผู้ใช้');
      return;
    }
    if (confirm(`คุณต้องการลบบัญชีพนักงาน [${username}] ใช่หรือไม่?`)) {
      setStaff(prev => prev.filter(s => s.user !== username));
      showToast(`ลบบัญชีผู้ใช้ ${username} สำเร็จ`);
    }
  };

  const renderActiveSubTab = () => {
    switch (subTab) {
      case 'dashboard':
        return (
          <OwnerDashboard
            orders={orders}
            expenses={expenses}
            menu={menu}
            menuPresets={menuPresets}
            setMenuPresets={setMenuPresets}
            showToast={showToast}
          />
        );

      case 'menu':
        return (
          <OwnerMenu
            menu={menu}
            addonPresets={addonPresets}
            setAddonPresets={setAddonPresets}
            showToast={showToast}
          />
        );

      // คลังวัตถุดิบ — the same inventory panel staff use, self-contained (owns
      // its own data + add/remove popups + ประวัติ audit trail).
      case 'stock':
        return <StockPanel menu={menu} showToast={showToast} />;

      // การเงิน — the ledger entry form plus the month summary that used to be
      // its own สรุปยอด tab. One page: record a movement of money, then read it
      // straight back against the month's takings in the ledger below.
      case 'finance':
        return (
          <div className="space-y-4">

            {/* ENTRY FORM — one form, two sides of the book. รายจ่าย is what it
                opens on; รายรับ is for money that never passed through a bill. */}
            <div className="bg-admin-panel border border-line rounded-2xl p-4 space-y-3">
              <div className="flex justify-between items-baseline">
                <h3 className="font-extrabold text-base font-kanit text-neutral-800">
                  เพิ่มรายการ{entryWord}
                </h3>
                <span className="text-[10px] text-neutral-500 font-medium">
                  วันที่: {formatThaiDate(expDate)}
                </span>
              </div>

              {/* Side switch. Same pill bar the ledger's ประเภท filter uses, but
                  the active pill carries the income/expense accent so which book
                  is being written to is readable without finding the heading. */}
              <div className="flex gap-1 bg-admin-bar rounded-full p-0.5 text-[11px] font-bold">
                {[
                  { id: 'expense', label: 'รายจ่าย' },
                  { id: 'income', label: 'รายรับ' },
                ].map(t => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setEntryType(t.id)}
                    className={`flex-1 px-3 py-2 rounded-full transition ${
                      entryType === t.id
                        ? `bg-admin-tab shadow-sm ${
                            t.id === 'income' ? 'text-admin-income' : 'text-admin-expense'
                          }`
                        : 'text-admin-tab-idle hover:text-admin-tab-hover'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <form onSubmit={handleAddEntry} className="space-y-3 text-xs font-thai">
                <div>
                  <div className="flex justify-between items-baseline mb-1">
                    <label htmlFor="exp-date" className="block font-bold text-neutral-500">วันที่</label>
                    {/* Back to today in one tap after filing an old receipt. */}
                    {expDate !== workdayKey() && (
                      <button
                        type="button"
                        onClick={() => setExpDate(workdayKey())}
                        className="text-[10px] font-bold text-amber-700 hover:underline"
                      >
                        กลับเป็นวันนี้
                      </button>
                    )}
                  </div>
                  {/* No `max`: an entry can be dated forward as well as back —
                      rent paid ahead, or a booking deposit taken now for a party
                      next month. text-neutral-800 because the field carries its
                      own background — an inherited colour goes invisible at night. */}
                  <input
                    id="exp-date"
                    type="date"
                    value={expDate}
                    onChange={e => setExpDate(e.target.value || workdayKey())}
                    className="w-full border rounded-xl p-2.5 bg-admin-field text-neutral-800 focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                  />
                </div>

                <div>
                  <label className="block font-bold text-neutral-500 mb-1">ชื่อร้าน</label>
                  <select
                    value={expShop}
                    onChange={e => setExpShop(e.target.value)}
                    className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                  >
                    {SHOPS.map(s => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block font-bold text-neutral-500 mb-1">ประเภท</label>
                    {/* Each side keeps its own dropdown and its own state, so
                        the two category lists never bleed into each other. */}
                    <select
                      value={entryCategory}
                      onChange={e =>
                        (isIncomeEntry ? setIncCategory : setExpCategory)(e.target.value)
                      }
                      className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                    >
                      {(isIncomeEntry ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-bold text-neutral-500 mb-1">
                      {isIncomeEntry ? 'จำนวนเงิน' : 'ราคา'}
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={expAmount}
                      // Satang is the smallest unit: a third decimal is refused
                      // as it is typed rather than silently rounded on save.
                      onChange={e => {
                        if (/^\d*(\.\d{0,2})?$/.test(e.target.value)) setExpAmount(e.target.value);
                      }}
                      className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold"
                      placeholder="กรอกตัวเลข ฿"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-neutral-500 mb-1">หมายเหตุ</label>
                  <textarea
                    value={expNote}
                    onChange={e => setExpNote(e.target.value)}
                    rows={3}
                    className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 resize-none"
                    placeholder={
                      isIncomeEntry
                        ? 'เช่น รับจัดเลี้ยงนอกร้าน, มัดจำงานวันเสาร์'
                        : 'เช่น ค่าน้ำแข็ง, ค่าแรงเบิกล่วงหน้า'
                    }
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-admin-cta hover:bg-admin-cta-hover text-admin-cta-ink font-bold py-3 rounded-2xl transition font-kanit"
                >
                  บันทึก{entryWord}
                </button>
              </form>
            </div>

            {/* MONTH SUMMARY + ประวัติรายรับ-รายจ่าย (was the สรุปยอด tab).
                Deleting a hand-keyed row — either side of the book — still runs
                through this component, which is the one that owns the list. */}
            <OwnerSummary
              orders={orders}
              expenses={expenses}
              month={ledgerMonth}
              setMonth={setLedgerMonth}
              showToast={showToast}
              onDeleteEntry={handleDeleteEntry}
            />

            {/* บิลทั้งหมด — the staff board's bill cards as a read-only review,
                filterable by working day or shown all at once. */}
            <OwnerBills orders={orders} />
          </div>
        );

      case 'timeclock':
        return (
          <div className="space-y-4 font-thai text-xs">

            {/* ADMIN ACTIONS — backfill a forgotten clock, edit an account */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={openBackfill}
                className="flex items-center justify-center gap-1.5 border-2 border-dashed border-neutral-300 hover:border-amber-500 hover:bg-amber-500/10 text-neutral-600 hover:text-amber-700 font-bold py-2.5 rounded-xl transition text-xs"
              >
                <CalendarClock className="w-4 h-4 flex-shrink-0" />
                <span>ลงเวลาย้อนหลัง</span>
              </button>
              <button
                onClick={openStaffEdit}
                className="flex items-center justify-center gap-1.5 border-2 border-dashed border-neutral-300 hover:border-amber-500 hover:bg-amber-500/10 text-neutral-600 hover:text-amber-700 font-bold py-2.5 rounded-xl transition text-xs"
              >
                <UserCog className="w-4 h-4 flex-shrink-0" />
                <span>แก้ไขข้อมูลพนักงาน</span>
              </button>
            </div>

            {/* TABLE 1 — MONTHLY SUMMARY: days, wage/day, salary, paid status */}
            <div className="bg-admin-card border rounded-2xl p-4 space-y-3 shadow-xs">
              <div className="flex justify-between items-center gap-2 flex-wrap">
                <h3 className="font-kanit font-extrabold text-xs text-neutral-400 uppercase tracking-wider">ตารางที่ 1: สรุปจำนวนวัน & เงินเดือน</h3>
                <input
                  type="month"
                  value={tcMonth}
                  onChange={(e) => setTcMonth(e.target.value)}
                  className="border rounded-xl p-2 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
                />
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-neutral-400 uppercase border-b border-neutral-100">
                      <th className="text-left py-2 font-extrabold">ชื่อ</th>
                      <th className="text-center py-2 font-extrabold">จำนวนวัน</th>
                      <th className="text-right py-2 font-extrabold">ค่าแรง/วัน</th>
                      <th className="text-right py-2 font-extrabold">เงินเดือน</th>
                      <th className="text-center py-2 font-extrabold">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {tcMonthlySummary.map((row) => (
                      <tr key={row.user}>
                        <td className="py-2.5">
                          <span className="font-bold text-neutral-800 block">{row.name}</span>
                          <span className="text-[10px] text-neutral-400">{row.position || row.user}</span>
                        </td>
                        <td className="py-2.5 text-center font-mono font-extrabold text-neutral-800">
                          {row.days > 0 ? row.days : <span className="text-neutral-300">0</span>}
                        </td>
                        <td className="py-2.5 text-right font-mono text-neutral-500">
                          {row.dailyWage > 0 ? row.dailyWage.toLocaleString() : <span className="text-neutral-300">—</span>}
                        </td>
                        <td className="py-2.5 text-right font-mono font-bold text-amber-700">
                          {row.salary > 0 ? row.salary.toLocaleString() : <span className="text-neutral-300">—</span>}
                        </td>
                        <td className="py-2.5 text-center">
                          <button
                            onClick={() => handleTogglePaid(row)}
                            className={`text-[10px] font-bold px-2.5 py-1 rounded-full transition ${
                              row.paid
                                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                                : 'bg-red-100 text-red-700 hover:bg-red-200'
                            }`}
                            title="แตะเพื่อสลับสถานะการจ่ายเงิน"
                          >
                            {row.paid ? 'จ่ายแล้ว ✓' : 'ยังไม่จ่าย'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-neutral-400">* นับเป็น 1 วันเมื่อมีทั้งเวลาเข้าและออก (ชั่วโมงมีไว้เช็กเข้าสายเท่านั้น) — เงินเดือน = จำนวนวัน × ค่าแรง/วัน</p>
            </div>

            {/* TABLE 2 — DAILY IN/OUT LOG (one row per event, by time) */}
            <div className="bg-admin-card border rounded-2xl p-4 space-y-3 shadow-xs">
              <div className="flex justify-between items-center gap-2 flex-wrap">
                <h3 className="font-kanit font-extrabold text-xs text-neutral-400 uppercase tracking-wider">ตารางที่ 2: ประวัติการเข้า-ออกรายวัน</h3>
                <input
                  type="date"
                  value={tcDate}
                  onChange={(e) => setTcDate(e.target.value)}
                  className="border rounded-xl p-2 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
                />
              </div>

              {tcDayEvents.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-neutral-400 uppercase border-b border-neutral-100">
                        <th className="text-left py-2 font-extrabold">เวลา</th>
                        <th className="text-left py-2 font-extrabold">ชื่อ</th>
                        <th className="text-center py-2 font-extrabold">สถานะ (เข้า/ออก)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {tcDayEvents.map((ev) => (
                        <tr key={ev.id}>
                          <td className="py-2.5 font-mono font-bold text-neutral-700">{tcTime(ev.at)}</td>
                          <td className="py-2.5 font-bold text-neutral-800">{ev.name}</td>
                          <td className="py-2.5 text-center">
                            <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full ${ev.kind === 'in' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                              {ev.kind === 'in' ? 'เข้า' : 'ออก'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-8 text-neutral-400 font-medium">ไม่มีการลงเวลาในวันที่เลือก</div>
              )}
            </div>

            {/* TABLE 3 — STOCK AUDIT TRAIL: every movement of คลังวัตถุดิบ, newest
                first. The staff panel shows the same log as a popup; here it is a
                table beside the attendance ones, because for the owner the two
                answer one question together: who was on shift, and what did the
                stock do while they were. */}
            <div className="bg-admin-card border rounded-2xl p-4 space-y-3 shadow-xs">
              <div className="flex justify-between items-center gap-2 flex-wrap">
                <h3 className="font-kanit font-extrabold text-xs text-neutral-400 uppercase tracking-wider">ตารางที่ 3: ประวัติอัปเดตสต็อก</h3>
                <button
                  onClick={loadStockHistory}
                  disabled={historyLoading}
                  className="flex items-center gap-1.5 border rounded-xl px-3 py-2 bg-admin-field hover:bg-neutral-100 font-bold text-xs transition disabled:opacity-50"
                  title="โหลดประวัติล่าสุดอีกครั้ง"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
                  <span>รีเฟรช</span>
                </button>
              </div>

              {historyLoading && (
                <div className="text-center py-8 text-neutral-400 font-medium">กำลังโหลดประวัติ…</div>
              )}

              {historyError && !historyLoading && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl flex items-center justify-between gap-3">
                  <span>{historyError}</span>
                  <button onClick={loadStockHistory} className="font-bold underline shrink-0">ลองใหม่</button>
                </div>
              )}

              {!historyLoading && !historyError && stockHistory.length === 0 && (
                <div className="text-center py-8 text-neutral-400 font-medium">ยังไม่มีประวัติการอัปเดตสต็อก</div>
              )}

              {!historyLoading && !historyError && stockHistory.length > 0 && (
                // Capped height with its own scroll: 200 rows would otherwise
                // push everything above it off the top of a long page.
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-admin-card">
                      <tr className="text-[10px] text-neutral-400 uppercase border-b border-neutral-100">
                        <th className="text-left py-2 font-extrabold whitespace-nowrap">เวลา</th>
                        <th className="text-left py-2 font-extrabold">รายการ</th>
                        <th className="text-center py-2 font-extrabold whitespace-nowrap">ประเภท</th>
                        <th className="text-right py-2 font-extrabold whitespace-nowrap">จำนวน</th>
                        <th className="text-right py-2 font-extrabold whitespace-nowrap">คงเหลือ</th>
                        <th className="text-left py-2 font-extrabold whitespace-nowrap">โดย</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {stockHistory.map((h) => (
                        <tr key={h.id}>
                          <td className="py-2.5 pr-2 font-mono text-neutral-500 whitespace-nowrap">{fmtStockTime(h.createdAt)}</td>
                          <td className="py-2.5 pr-2">
                            {/* A 'restock-all' row is an aggregate with no item of
                                its own, so it says so rather than showing a dash. */}
                            <span className="font-bold text-neutral-800 block">
                              {h.itemName || (h.action === 'restock-all' ? 'ทุกรายการในคลัง' : '—')}
                            </span>
                            {h.category && (
                              <span className="text-[10px] text-neutral-400 font-medium block">{h.category}</span>
                            )}
                            {/* The reason typed when units were taken out. */}
                            {h.note && (
                              <span className="text-[10px] text-red-500 font-medium block">📝 {h.note}</span>
                            )}
                          </td>
                          <td className="py-2.5 px-1 text-center">
                            <span className={`text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap ${STOCK_ACTION_COLORS[h.action] || 'bg-neutral-100 text-neutral-600'}`}>
                              {STOCK_ACTION_LABELS[h.action] || h.action}
                            </span>
                          </td>
                          <td className="py-2.5 pl-2 text-right font-mono font-extrabold whitespace-nowrap">
                            {h.delta === 0 ? (
                              <span className="text-neutral-300">—</span>
                            ) : (
                              <span className={h.delta > 0 ? 'text-emerald-600' : 'text-red-500'}>
                                {h.delta > 0 ? `+${h.delta}` : h.delta}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pl-2 text-right font-mono text-neutral-500">
                            {h.quantityAfter != null ? h.quantityAfter : <span className="text-neutral-300">—</span>}
                          </td>
                          <td className="py-2.5 pl-2 font-bold text-neutral-700 whitespace-nowrap">
                            {h.byName || h.byUser || 'ไม่ทราบ'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <p className="text-[10px] text-neutral-400">* แสดง {stockHistory.length} รายการล่าสุด (สูงสุด 200) เรียงจากใหม่ไปเก่า — บันทึกอัตโนมัติทุกครั้งที่สต็อกขยับ รวมถึงตอนกดเสิร์ฟ</p>
            </div>
          </div>
        );

      case 'settings':
        return (
          <div className="space-y-4">
            
            {/* MAIN SETTINGS CONFIG */}
            <form onSubmit={handleSaveSettings} className="bg-admin-card border rounded-2xl p-4 space-y-3.5 shadow-xs font-thai text-xs">
              <h3 className="font-kanit font-extrabold text-xs text-neutral-400 uppercase tracking-wider">ตั้งค่าระบบทั่วไป</h3>
              
              <div>
                <label className="block font-bold text-neutral-500 mb-1">ชื่อร้านค้า (ฝั่งกลางวัน)</label>
                <input
                  type="text"
                  value={settingsDraft.name}
                  onChange={e => setSettingsDraft({ ...settingsDraft, name: e.target.value })}
                  className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
                  required
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-500 mb-1">ชื่อร้านค้า (ฝั่งกลางคืน)</label>
                <input
                  type="text"
                  value={settingsDraft.nameNight || ''}
                  onChange={e => setSettingsDraft({ ...settingsDraft, nameNight: e.target.value })}
                  className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
                  required
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-500 mb-1">จำนวนโต๊ะให้บริการทั้งหมด</label>
                <input 
                  type="number"
                  min="1"
                  max="100"
                  value={settingsDraft.tables}
                  onChange={e => setSettingsDraft({ ...settingsDraft, tables: Math.max(1, parseInt(e.target.value) || 1) })}
                  className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono font-bold"
                  required
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-500 mb-1">URL หลักระบบของร้าน (สำหรับสร้าง QR Code)</label>
                <input 
                  type="text"
                  value={settingsDraft.baseUrl}
                  onChange={e => setSettingsDraft({ ...settingsDraft, baseUrl: e.target.value })}
                  placeholder={window.location.origin + window.location.pathname}
                  className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-[11px]"
                />
              </div>

              <div>
                <label className="block font-bold text-neutral-500 mb-1">เบอร์พร้อมเพย์ร้าน (สำหรับ QR รับชำระเงิน)</label>
                <input
                  type="text"
                  value={settingsDraft.promptpayId || ''}
                  onChange={e => setSettingsDraft({ ...settingsDraft, promptpayId: e.target.value })}
                  placeholder="เบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก"
                  className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono"
                />
                <p className="text-[10px] text-neutral-400 mt-1">เว้นว่างไว้ = ปิดตัวเลือกจ่ายด้วย QR ตอนเช็คบิล</p>
              </div>

              <button 
                type="submit"
                className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition text-center"
              >
                บันทึกการตั้งค่าระบบ
              </button>
            </form>

            {/* STAFF CRUD ACCOUNTS MANAGEMENT */}
            <div className="bg-admin-card border rounded-2xl p-4 space-y-4 shadow-xs font-thai text-xs">
              <h3 className="font-kanit font-extrabold text-xs text-neutral-400 uppercase tracking-wider">จัดการสิทธิ์พนักงาน</h3>
              
              <div className="divide-y divide-neutral-100 max-h-36 overflow-y-auto">
                {staff.map(s => (
                  <div key={s.user} className="py-2.5 flex justify-between items-center text-xs">
                    <div>
                      <span className="font-bold text-neutral-800 block">
                        {s.name}
                        {s.position && <span className="ml-1.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded-full">{s.position}</span>}
                        {s.role === 'inventory' && <span className="ml-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded-full">ผู้จัดการคลัง</span>}
                        {s.shop && (
                          <span className="ml-1 text-[10px] font-semibold text-neutral-500 bg-neutral-100 px-1.5 py-0.5 rounded-full">
                            {s.shop === 'night' ? (settings.nameNight || 'เรือนเก่า') : settings.name}
                          </span>
                        )}
                      </span>
                      <span className="text-neutral-400 font-mono text-[10px]">
                        ชื่อผู้ใช้: {s.user} &bull; รหัสผ่าน:{' '}
                        {/* An account with no password is not broken — it is
                            waiting for its person to choose one at first login.
                            Say which, so the owner knows nothing is missing. */}
                        {s.hasPass === false
                          ? <span className="text-amber-600 font-bold font-thai">รอพนักงานตั้งเอง</span>
                          : '••••••'}
                        &bull; ไอดี:{' '}
                        {/* Shown in full: the owner is who hands the codes out and
                            has to be able to read one back to whoever forgot it.
                            Only an owner session is ever sent the digits.
                            Three states, all worth telling apart — a readable
                            code, a code set before it was stored readably (hash
                            only, so it can only be replaced), and no code at all,
                            which means this account cannot sign a bill. */}
                        {s.pin
                          ? <span className="font-bold text-neutral-700 tracking-[0.15em]">{s.pin}</span>
                          : s.hasPin
                            ? <span className="font-thai text-neutral-400">•••• (ตั้งไอดีใหม่เพื่อให้เห็นเลข)</span>
                            : <span className="text-red-500 font-bold font-thai">ยังไม่ได้ตั้ง</span>}
                        {s.dailyWage > 0 && <> &bull; ค่าแรง {s.dailyWage.toLocaleString()} บาท/วัน</>}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDeleteStaffAccount(s.user)}
                      className="text-red-500 hover:text-red-700 p-1.5 hover:bg-red-500/10 rounded-lg transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>

              {/* ADD NEW STAFF FORM */}
              <form onSubmit={handleAddStaffAccount} className="border-t border-neutral-100 pt-3.5 space-y-3">
                <h3 className="font-extrabold text-base font-kanit text-neutral-800">เพิ่มพนักงานใหม่</h3>
                
                <div className="grid grid-cols-2 gap-2 items-end">
                  <input
                    type="text"
                    value={newStaffName}
                    onChange={e => setNewStaffName(e.target.value)}
                    placeholder="ชื่อที่แสดง (เช่น เจ๊แหม่ม)"
                    className="border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                  />
                  <div>
                    <label className="text-[10px] font-bold text-neutral-400 block mb-1">ร้านที่ประจำ</label>
                    <select
                      value={newStaffShop}
                      onChange={e => setNewStaffShop(e.target.value)}
                      className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold font-thai"
                    >
                      <option value="day">{settings.name} (กลางวัน)</option>
                      <option value="night">{settings.nameNight || 'เรือนเก่า'} (กลางคืน)</option>
                    </select>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-2 items-end">
                  <input
                    type="text"
                    value={newStaffPosition}
                    onChange={e => setNewStaffPosition(e.target.value)}
                    placeholder="ตำแหน่ง (เช่น เสิร์ฟ, ครัว)"
                    className="border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                  />
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={newStaffWage}
                    onChange={e => setNewStaffWage(e.target.value)}
                    placeholder="ค่าแรง (บาท/วัน)"
                    className="border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-neutral-400 block mb-1">สิทธิ์การเข้าถึง</label>
                  <select
                    value={newStaffRole}
                    onChange={e => setNewStaffRole(e.target.value)}
                    className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold font-thai"
                  >
                    {ROLE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>

                <input
                  type="text"
                  value={newStaffUser}
                  onChange={e => setNewStaffUser(e.target.value)}
                  placeholder="ชื่อผู้ใช้งานเข้าระบบ"
                  className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                  required
                />

                <div className="grid grid-cols-2 gap-2">
                  {/* Optional — see handleAddStaffAccount. Blank hands the
                      account over without a password and the staff member sets
                      their own at first sign-in. */}
                  <input
                    type="text"
                    value={newStaffPass}
                    onChange={e => setNewStaffPass(e.target.value)}
                    placeholder="รหัสผ่าน (เว้นว่างได้)"
                    className="border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono"
                  />
                  {/* ไอดีพนักงาน (PIN 4 หลัก) — typed at the till to sign a bill or
                      a discount, so it must be unique per person. Digits only:
                      the numeric keypad is what staff will actually be using. */}
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4}"
                    maxLength={4}
                    value={newStaffPin}
                    onChange={e => setNewStaffPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="ไอดีพนักงาน (4 หลัก)"
                    className="border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono tracking-[0.3em]"
                    required
                  />
                </div>
                <p className="text-[10px] text-neutral-400 leading-snug">
                  ไอดีพนักงานคือเลข 4 หลักที่พนักงานคนนี้ต้องกดทุกครั้งที่พิมพ์บิลหรือให้ส่วนลด
                  เพื่อบันทึกว่าใครเป็นคนทำ — ห้ามซ้ำกับคนอื่น
                </p>
                <p className="text-[10px] text-neutral-400 leading-snug">
                  เว้นช่องรหัสผ่านว่างไว้ได้ — พนักงานจะถูกให้ตั้งรหัสผ่านเองตอนเข้าสู่ระบบครั้งแรก
                  (ระหว่างนั้นใครที่รู้ชื่อผู้ใช้ก็เข้าไปตั้งได้ ควรบอกเฉพาะเจ้าตัว)
                </p>
                <button
                  type="submit"
                  className="w-full bg-ctl hover:bg-ctl-hover text-ctl-ink font-bold py-2.5 rounded-xl transition font-thai"
                >
                  + เพิ่มพนักงาน
                </button>
              </form>
            </div>

            {/* TABLE QR CODES — printing table stickers is a setup job for the
                owner; kept at the bottom of the settings page. */}
            <TableQrCodes settings={settings} />

          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-4 font-thai text-sm">

      {/* SUB-TABS SELECTOR */}
      {/* Colours come from the --c-admin-* palette in index.css, so the whole
          bar can be re-coloured there without editing this file. */}
      <div className="flex gap-1 bg-admin-bar rounded-xl p-1 text-[10px] font-bold">
        {[
          { id: 'dashboard', label: 'ภาพรวม', icon: LayoutDashboard },
          { id: 'menu', label: 'จัดการเมนู', icon: UtensilsCrossed },
          { id: 'stock', label: 'คลัง', icon: Package },
          // การเงิน absorbed the old สรุปยอด tab — บันทึกรายจ่าย, สรุปยอดรายเดือน
          // and ประวัติรายรับ-รายจ่าย all live behind this one wallet icon now.
          { id: 'finance', label: 'การเงิน', icon: Wallet },
          { id: 'timeclock', label: 'ข้อมูลพนักงาน', icon: Users },
          { id: 'settings', label: 'ตั้งค่า', icon: SettingsIcon }
        ].map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              // Icon-only tabs on a phone: the label is kept as title/aria-label
              // for tooltips + screen readers, but not rendered as text. With
              // five tabs sharing one row in the narrow shell, dropping the words
              // gives each icon room to breathe. A desktop has the width to spell
              // them out, so the text comes back at lg.
              title={tab.label}
              aria-label={tab.label}
              // shadow-sm, not shadow-xs: shadow-xs is a Tailwind v4 class and
              // this project is on v3, where it compiles to nothing at all —
              // which is what left the selected tab as white-on-near-white.
              className={`flex-1 py-2.5 px-0.5 rounded-lg flex items-center justify-center gap-1.5 transition ${tab.id === subTab ? 'bg-admin-tab text-admin-tab-ink shadow-sm' : 'text-admin-tab-idle hover:text-admin-tab-hover'}`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              <span className="hidden lg:inline text-xs font-kanit">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* RENDER VIEW AREA */}
      {renderActiveSubTab()}

      {/* BACKFILL MODAL — admin logs a forgotten clock-in/out */}
      {backfill && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setBackfill(null)}>
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-md w-full p-6 space-y-4 text-neutral-800 max-h-[85vh] overflow-y-auto shadow-2xl border-t border-neutral-100 font-thai" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-base font-extrabold font-kanit">ลงเวลาย้อนหลัง</h3>
                <span className="text-[10px] text-neutral-400 font-medium">สำหรับกรณีพนักงานลืมลงเวลาเข้า/ออก</span>
              </div>
              <button onClick={() => setBackfill(null)} className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition">✕</button>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">พนักงาน</label>
              <select
                value={backfill.user}
                onChange={(e) => setBackfill({ ...backfill, user: e.target.value })}
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
              >
                {(staff || []).map((s) => (
                  <option key={s.user} value={s.user}>{s.name} ({s.user})</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">วันที่</label>
              <input
                type="date"
                value={backfill.date}
                onChange={(e) => setBackfill({ ...backfill, date: e.target.value })}
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-600 block">เวลาเข้า</label>
                <input
                  type="time"
                  value={backfill.inTime}
                  onChange={(e) => setBackfill({ ...backfill, inTime: e.target.value })}
                  className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] font-extrabold uppercase tracking-wider text-amber-600 block">เวลาออก</label>
                <input
                  type="time"
                  value={backfill.outTime}
                  onChange={(e) => setBackfill({ ...backfill, outTime: e.target.value })}
                  className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold text-xs"
                />
              </div>
            </div>
            <p className="text-[10px] text-neutral-400">เว้นว่างช่องใดช่องหนึ่งได้ (เช่น ลงเฉพาะเวลาออกที่ลืม) — ถ้ามีบันทึกของวันนั้นอยู่แล้ว ระบบจะแก้ไขให้</p>

            <button
              onClick={handleSaveBackfill}
              disabled={savingClock}
              className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition text-sm disabled:opacity-50"
            >
              {savingClock ? 'กำลังบันทึก…' : 'บันทึกเวลา'}
            </button>
          </div>
        </div>
      )}

      {/* STAFF EDIT MODAL — ชื่อ / ชื่อผู้ใช้ / รหัสผ่าน / ค่าแรง */}
      {staffEdit && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setStaffEdit(null)}>
          <div className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-md w-full p-6 space-y-4 text-neutral-800 max-h-[85vh] overflow-y-auto shadow-2xl border-t border-neutral-100 font-thai" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="text-base font-extrabold font-kanit">แก้ไขข้อมูลพนักงาน</h3>
                <span className="text-[10px] text-neutral-400 font-medium">ชื่อที่แสดง ชื่อผู้ใช้ รหัสผ่าน สิทธิ์การเข้าถึง และค่าแรงต่อวัน</span>
              </div>
              <button onClick={() => setStaffEdit(null)} className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition">✕</button>
            </div>

            {/* Which account. Switching reloads the fields from the stored
                record, so a half-typed edit is never carried onto someone else. */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">เลือกพนักงาน</label>
              <select
                value={staffEdit.original}
                onChange={(e) => setStaffEdit(loadStaffEdit(e.target.value))}
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
              >
                {(staff || []).map((s) => (
                  <option key={s.user} value={s.user}>{s.name} ({s.user})</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">ชื่อที่แสดง</label>
              <input
                type="text"
                value={staffEdit.name}
                onChange={(e) => setStaffEdit({ ...staffEdit, name: e.target.value })}
                placeholder="เช่น เจ๊แหม่ม"
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">ชื่อผู้ใช้ (เข้าระบบ)</label>
              <input
                type="text"
                value={staffEdit.user}
                onChange={(e) => setStaffEdit({ ...staffEdit, user: e.target.value })}
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
              />
              {staffEdit.user.trim() !== staffEdit.original && (
                <p className="text-[10px] text-amber-700 font-bold">
                  เปลี่ยนชื่อผู้ใช้ — ประวัติการลงเวลาและสถานะจ่ายเงินเดือนจะย้ายตามไปด้วย
                  แต่ต้องใช้ชื่อใหม่นี้ในการเข้าสู่ระบบครั้งต่อไป
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">รหัสผ่านใหม่</label>
              <input
                type="text"
                value={staffEdit.pass}
                onChange={(e) => setStaffEdit({ ...staffEdit, pass: e.target.value })}
                placeholder="เว้นว่างไว้ = ใช้รหัสผ่านเดิม"
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono text-xs"
              />
              {/* The stored password is a one-way hash — nobody, including this
                  screen, can read the current one back. Only replacing it is
                  possible, and saying so beats an empty box that looks broken. */}
              <p className="text-[10px] text-neutral-400">
                ระบบเก็บรหัสผ่านแบบเข้ารหัส จึงดูรหัสเดิมไม่ได้ ตั้งใหม่ได้อย่างเดียว
                {staffEdit.hasPass === false && (
                  <span className="text-amber-600 font-bold"> · บัญชีนี้ยังไม่มีรหัสผ่าน พนักงานจะตั้งเองตอนเข้าระบบครั้งแรก</span>
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 flex items-center justify-between gap-2">
                <span>ไอดีพนักงานใหม่ (4 หลัก)</span>
                {/* The code in force right now, so the owner can read it out to
                    the person who forgot it without having to replace it. */}
                {staffEdit.currentPin && (
                  <span className="font-mono text-[11px] tracking-[0.2em] text-neutral-700 normal-case">
                    ปัจจุบัน: {staffEdit.currentPin}
                  </span>
                )}
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                value={staffEdit.pin}
                onChange={(e) => setStaffEdit({ ...staffEdit, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder={staffEdit.hasPin ? 'เว้นว่างไว้ = ใช้ไอดีเดิม' : 'ยังไม่ได้ตั้งไอดี — ตั้งเลย'}
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono text-xs tracking-[0.3em]"
              />
              <p className="text-[10px] text-neutral-400">
                ใช้กดยืนยันตอนพิมพ์บิลและให้ส่วนลด · เจ้าของร้านดูเลขปัจจุบันได้ในหน้านี้
                {staffEdit.hasPin && !staffEdit.currentPin && (
                  <span className="text-neutral-500"> · ไอดีเดิมตั้งไว้ก่อนระบบจะเก็บเลขให้ดู จึงยังดูไม่ได้ — ตั้งใหม่แล้วจะเห็น</span>
                )}
                {!staffEdit.hasPin && (
                  <span className="text-red-500 font-bold"> · บัญชีนี้ยังพิมพ์บิลไม่ได้จนกว่าจะตั้งไอดี</span>
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">สิทธิ์การเข้าถึง</label>
              {/* Locked on your own account: the server refuses it anyway, since
                  stepping down from ผู้บริหาร would lock you out of this screen. */}
              <select
                value={staffEdit.role}
                onChange={(e) => setStaffEdit({ ...staffEdit, role: e.target.value })}
                disabled={staffEdit.original === activeStaffUser}
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold font-thai text-xs disabled:opacity-60"
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {staffEdit.original === activeStaffUser ? (
                <p className="text-[10px] text-neutral-400">เปลี่ยนสิทธิ์ของบัญชีที่กำลังเข้าใช้งานอยู่ไม่ได้</p>
              ) : staffEdit.role !== staffEdit.originalRole && (
                <p className="text-[10px] text-amber-700 font-bold">
                  เปลี่ยนจาก {roleLabel(staffEdit.originalRole)} เป็น {roleLabel(staffEdit.role)} —
                  หน้าจอของพนักงานคนนี้จะเปลี่ยนตามเมื่อเข้าสู่ระบบครั้งถัดไป
                </p>
              )}
            </div>

            {/* No wage box for an owner account — เจ้าของร้าน is the one paying. */}
            {staffEdit.role === 'owner' ? (
              <p className="text-[10px] text-neutral-400 bg-neutral-50 border rounded-xl p-2.5 leading-normal">
                บัญชีเจ้าของร้านไม่มีค่าแรง/เงินเดือน จึงไม่แสดงในตารางเงินเดือน
              </p>
            ) : (
              <div className="space-y-1.5">
                <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">ค่าแรง (บาท/วัน)</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={staffEdit.dailyWage}
                  onChange={(e) => setStaffEdit({ ...staffEdit, dailyWage: e.target.value })}
                  placeholder="เช่น 400"
                  className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold text-xs"
                />
                <p className="text-[10px] text-neutral-400">เงินเดือน = จำนวนวันที่มาทำงาน × ค่าแรงต่อวัน — แก้ค่านี้แล้วยอดในตารางจะคิดใหม่ทันที</p>
              </div>
            )}

            <button
              onClick={handleSaveStaffEdit}
              disabled={savingStaff}
              className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition text-sm disabled:opacity-50"
            >
              {savingStaff ? 'กำลังบันทึก…' : 'บันทึกข้อมูลพนักงาน'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

export default OwnerView;
