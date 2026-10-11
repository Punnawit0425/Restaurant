import { useState, useRef, useCallback } from 'react';
import { fetchStockHistory } from './api';
import { workdayKey } from './shift';

// How a stock_history row is presented. Shared by the staff คลังวัตถุดิบ
// ประวัติ panel and the owner's "ตารางที่ 2: ประวัติอัปเดตสต็อก", so the two
// can never label the same movement differently.
//
// The action values come from the server (see schema/stock_history_schema.sql).
// Unknown actions fall back to the raw string / a neutral grey rather than
// rendering blank, so a newly added action is still legible before this list
// catches up.
export const STOCK_ACTION_LABELS = {
  adjust: 'ปรับจำนวน',
  'restock-all': 'เติมทั้งหมด',
  create: 'เพิ่ม/เติมรายการ',
  serve: 'ตัดสต็อก (เสิร์ฟ)',
  unserve: 'คืนสต็อก (ยกเลิกเสิร์ฟ)',
};

export const STOCK_ACTION_COLORS = {
  adjust: 'bg-sky-100 text-sky-700',
  'restock-all': 'bg-emerald-100 text-emerald-700',
  create: 'bg-emerald-100 text-emerald-700',
  serve: 'bg-amber-100 text-amber-700',
  unserve: 'bg-neutral-100 text-neutral-600',
};

// "31 ก.ค. 14:32" — compact Thai date+time for a history row.
export const fmtStockTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('th-TH', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
};

// --- Loading the log ---------------------------------------------------------
// The one loader behind all three views of this log (the owner's table, the
// คลัง ประวัติ popup, the staff popup), so they page through days the same way.
//
// The log is kept per WORKING day (06:00 → 06:00): `date` is the day on screen,
// opening on the one in progress. Changing it fetches that day at once. Capped
// at the server's maximum per request; a view says so when a day reaches it.
export const STOCK_HISTORY_DAY_LIMIT = 500;

export function useStockHistory() {
  const [date, setDateState] = useState(() => workdayKey());
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Only the newest request may write: flicking through dates fires several,
  // and an older day answering last must not land under the newer day's label.
  const latest = useRef(0);

  const load = useCallback(async (day) => {
    const n = ++latest.current;
    setLoading(true);
    setError('');
    try {
      const rows = await fetchStockHistory(STOCK_HISTORY_DAY_LIMIT, day);
      if (n === latest.current) setItems(rows);
    } catch (err) {
      if (n === latest.current) setError(err.message || 'โหลดประวัติการบันทึกสต็อกไม่สำเร็จ');
    } finally {
      if (n === latest.current) setLoading(false);
    }
  }, []);

  // Show another day (and fetch it). An empty value — a cleared date box —
  // goes back to the day in progress.
  const setDate = useCallback((day) => {
    const next = day || workdayKey();
    setDateState(next);
    load(next);
  }, [load]);

  const reload = useCallback(() => load(date), [load, date]);

  return { items, loading, error, date, setDate, reload };
}
