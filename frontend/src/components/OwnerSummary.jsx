import React, { useState, useMemo, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { FileSpreadsheet, Trash2 } from 'lucide-react';
import { shopLabel, THAI_MONTHS_FULL, formatThaiDate, roundBaht, formatBaht } from '../expenses';
import { workdayKey } from '../shift';
import {
  availableMonths,
  summaryRows,
  summaryTotals,
  ledgerRows,
  takingsByMethod,
  expensesByCategory,
  PAY_METHODS
} from '../stats';

const baht = formatBaht;

const LEDGER_PAGE_SIZE = 20;

// 'YYYY-MM' -> 'กรกฎาคม 2569'
function monthLabel(key) {
  const [y, m] = (key || '').split('-').map(Number);
  if (!y || !m) return key || '';
  return `${THAI_MONTHS_FULL[m - 1]} ${y + 543}`;
}

// 'YYYY-MM-DD' -> '18/07/2026', matching the export sheet.
function shortDate(key) {
  const [y, m, d] = (key || '').split('-');
  return `${d}/${m}/${y}`;
}

// The ประเภท filter above the table.
const KIND_FILTERS = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'income', label: 'รายรับ' },
  { id: 'expense', label: 'รายจ่าย' },
];

// The money half of the back office: pick a month, read the takings against the
// outgoings, export the sheet. Rendered under the expense entry form inside the
// การเงิน tab — the two used to be separate tabs (รายจ่าย / สรุปยอด).
//
// `onDeleteEntry(id, category, amount, kind)` comes from OwnerView, which owns
// the ledger list. Only the rolled-up bill income rows have no id, and those are
// the ones that are never deletable here — the bills own that money.
//
// `month` / `setMonth` are lifted to OwnerView too: saving an entry dated into
// another month has to move this table to it, and only the form knows that.
function OwnerSummary({ orders, expenses, month, setMonth, showToast, onDeleteEntry }) {
  // Every month with trade in it — plus whichever month is selected, even when
  // it has none. Picking a quiet day in รายวัน moves the month to that day's,
  // and a <select> whose value is not among its options shows the wrong month.
  const months = useMemo(() => {
    const list = availableMonths(orders, expenses);
    return list.includes(month) ? list : [...list, month].sort().reverse();
  }, [orders, expenses, month]);
  const [kind, setKind] = useState('all'); // all | income | expense

  // Two shapes of the same month: `ledger` is what the table shows (every expense
  // on its own row), `rows` is the rolled-up shape the Excel export wants.
  const ledger = useMemo(() => ledgerRows(orders, expenses, month), [orders, expenses, month]);
  const rows = useMemo(() => summaryRows(orders, expenses, month), [orders, expenses, month]);

  // Totals always cover the WHOLE month, never the filtered view — the filter is
  // for reading the list, not for changing what the month earned.
  const totals = useMemo(() => summaryTotals(ledger), [ledger]);
  const visible = useMemo(
    () => (kind === 'all' ? ledger : ledger.filter((r) => r.kind === kind)),
    [ledger, kind]
  );

  // --- Paging the history ---
  // A new month or a new filter is a new list, so it starts on its first page.
  // The page is clamped rather than trusted: deleting the last row of the last
  // page must not leave the table showing nothing.
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [month, kind]);
  const pageCount = Math.max(1, Math.ceil(visible.length / LEDGER_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const firstRow = safePage * LEDGER_PAGE_SIZE;
  const pageRows = useMemo(
    () => visible.slice(firstRow, firstRow + LEDGER_PAGE_SIZE),
    [visible, firstRow]
  );

  // --- TAKINGS TABLE PERIOD ---
  // The table can be read a whole month at a time or one day at a time; the rest
  // of the page (ประวัติ + export) is always the month, since a one-day book is
  // not a thing the owner asks for.
  const [period, setPeriod] = useState('month'); // month | day
  const [day, setDay] = useState(() => workdayKey());

  // Picking a day also moves the month everything else is scoped to, so the list
  // below can never be showing August while this table shows a day in September.
  const pickDay = (value) => {
    const next = value || workdayKey();
    setDay(next);
    setMonth(next.slice(0, 7));
  };
  // Switching to รายวัน must NOT jump months: if the page is parked on an older
  // month, open on its first day rather than snapping back to today.
  const pickPeriod = (next) => {
    setPeriod(next);
    if (next === 'day' && !day.startsWith(month)) setDay(`${month}-01`);
  };

  // Where the money came in: one row per money type, the two shops as columns.
  // 'YYYY-MM' or 'YYYY-MM-DD' — takingsByMethod reads either as a prefix.
  const periodKey = period === 'day' ? day : month;
  const takings = useMemo(
    () => takingsByMethod(orders, expenses, periodKey),
    [orders, expenses, periodKey]
  );
  // รายรับนอกบิล is not a way of being paid, it is the absence of one — so the
  // row only appears when something was actually keyed in by hand.
  const takingRows = useMemo(
    () => PAY_METHODS.filter((m) => m.id !== 'other' || takings.all.other > 0),
    [takings]
  );

  // Where the month's outgoings went, one row per category actually spent on.
  // Always the whole month (like ประวัติ below), even while the takings table
  // above is reading a single day.
  const spending = useMemo(() => expensesByCategory(expenses, month), [expenses, month]);

  // The same month totals, but split by shift so day and night can be checked
  // side by side. Each shift also carries its own rows for the per-sheet export.
  const byShift = useMemo(() => {
    const make = (id) => {
      const shopRows = rows.filter((r) => r.shop === id);
      return { id, rows: shopRows, ...summaryTotals(shopRows) };
    };
    return { day: make('day'), night: make('night') };
  }, [rows]);

  // Turn a set of summary rows into the sheet shape, with trailing totals so each
  // sheet balances on its own.
  const buildSheet = (sheetRows) => {
    const t = summaryTotals(sheetRows);
    const body = sheetRows.map((r) => ({
      'วันที่': shortDate(r.date),
      'ร้าน': shopLabel(r.shop),
      'ประเภท': r.kind === 'income' ? 'รายรับ' : 'รายจ่าย',
      'รายการ': r.label,
      'จำนวนเงิน ฿': roundBaht(r.amount)
    }));
    body.push({}, {
      'วันที่': 'รวมทั้งเดือน', 'ร้าน': '', 'ประเภท': 'รายรับ', 'รายการ': '', 'จำนวนเงิน ฿': roundBaht(t.income)
    }, {
      'วันที่': '', 'ร้าน': '', 'ประเภท': 'รายจ่าย', 'รายการ': '', 'จำนวนเงิน ฿': roundBaht(t.expense)
    }, {
      'วันที่': '', 'ร้าน': '', 'ประเภท': 'กำไรสุทธิ', 'รายการ': '', 'จำนวนเงิน ฿': roundBaht(t.profit)
    });
    const ws = XLSX.utils.json_to_sheet(body);
    // Show the amount column to 2 decimal places, same as the ledger on screen.
    Object.keys(ws).forEach((ref) => {
      if (/^E\d+$/.test(ref) && typeof ws[ref].v === 'number') ws[ref].z = '#,##0.00';
    });
    ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 10 }, { wch: 26 }, { wch: 14 }];
    return ws;
  };

  const handleExport = () => {
    if (rows.length === 0) {
      alert('เดือนนี้ยังไม่มีข้อมูลสำหรับส่งออก');
      return;
    }

    // One workbook, three tabs: everything together, then day and night on their
    // own so each shift can be checked / handed off in isolation. Empty shifts
    // are skipped rather than adding a blank tab.
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildSheet(rows), 'ทั้งหมด');
    if (byShift.day.rows.length) {
      XLSX.utils.book_append_sheet(wb, buildSheet(byShift.day.rows), 'กลางวัน');
    }
    if (byShift.night.rows.length) {
      XLSX.utils.book_append_sheet(wb, buildSheet(byShift.night.rows), 'กลางคืน');
    }
    XLSX.writeFile(wb, `สรุปยอด_${monthLabel(month).replace(/\s/g, '_')}.xlsx`);
    showToast('ส่งออกไฟล์ Excel สำเร็จ ✓');
  };

  return (
    <div className="space-y-4">

      {/* TAKINGS BY MONEY TYPE — how the period's รายรับ arrived, split across
          the two shops. The dashboard shows the same split for a single day as
          three tiles; this reads as a table because four rows × three columns is
          a table. Footed with รวมรายรับ, which in รายเดือน is the same number the
          ประวัติ list totals to.

          Both pickers live in THIS card's header, sitting on the table they most
          obviously change, rather than floating above the page as a bar of their
          own — a control with nothing under it reads as belonging to nothing.
          The month still scopes everything below as well (ประวัติ + the export),
          which is why those carry the chosen month as a label. */}
      <div className="bg-admin-card border rounded-2xl overflow-hidden shadow-xs">
        <div className="px-3 py-2.5 bg-neutral-50 border-b space-y-2">
          <span className="block text-[11px] font-extrabold text-neutral-700 font-kanit">
            เงินที่ได้รับแยกตามช่องทาง
          </span>
          {/* text-neutral-600/800 rather than an inherited colour on all three:
              each box carries its own background (bg-admin-field), so its text
              has to track that surface rather than the shell behind it. Both
              flip together. */}
          <div className="flex items-center gap-2">
            <select
              value={period}
              onChange={e => pickPeriod(e.target.value)}
              className="shrink-0 border rounded-full py-1.5 px-3 bg-admin-field text-[11px] font-bold text-neutral-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              <option value="month">รายเดือน</option>
              <option value="day">รายวัน</option>
            </select>

            {period === 'day' ? (
              // No `max`: รายรับนอกบิล can be dated forward (a deposit taken now
              // for next month's party), so a future day is a real thing to read.
              <input
                type="date"
                value={day}
                onChange={e => pickDay(e.target.value)}
                className="flex-1 min-w-0 border rounded-full py-1.5 px-3 bg-admin-field text-[11px] font-bold text-neutral-800 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
            ) : (
              <select
                value={month}
                onChange={e => setMonth(e.target.value)}
                className="flex-1 min-w-0 border rounded-full py-1.5 px-3 bg-admin-field text-[11px] font-bold text-neutral-600 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {months.map(m => (
                  <option key={m} value={m}>{monthLabel(m)}</option>
                ))}
              </select>
            )}
          </div>
          {/* The date box prints its value in the Gregorian year; this is the
              same day in the พ.ศ. form the owner actually reads dates in. */}
          {period === 'day' && (
            <span className="block text-[10px] font-bold text-neutral-500 font-thai">
              วันทำการ {formatThaiDate(day)} (06:00 ถึง 06:00 ของวันถัดไป)
            </span>
          )}
        </div>

        <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-1.5 px-3 py-2 bg-neutral-50 border-b text-[9.5px] font-extrabold text-neutral-500 font-kanit">
          <span>ช่องทาง</span>
          <span className="text-right">กลางวัน</span>
          <span className="text-right">กลางคืน</span>
          <span className="text-right">รวม</span>
        </div>

        {/* A day with no trade is normal (the shop was shut, or it has not
            happened yet), and four rows of 0 say that far less clearly than
            saying it. The month view keeps the rows — a month rarely has none. */}
        {takings.all.total === 0 && period === 'day' ? (
          <p className="text-neutral-500 text-xs py-6 text-center font-medium font-thai">
            ยังไม่มีรายรับในวันที่ {formatThaiDate(day)}
          </p>
        ) : (
          <>
            {takingRows.map(m => (
              <div
                key={m.id}
                className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-1.5 px-3 py-2.5 border-b border-neutral-100 text-[11px] items-center font-thai"
              >
                <span className="font-bold text-neutral-800 leading-tight">{m.label}</span>
                <span className="text-right font-mono text-neutral-600">{baht(takings.day[m.id])}</span>
                <span className="text-right font-mono text-neutral-600">{baht(takings.night[m.id])}</span>
                <span className="text-right font-mono font-bold text-admin-income">{baht(takings.all[m.id])}</span>
              </div>
            ))}
            <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-1.5 px-3 py-2.5 bg-admin-panel text-[11px] items-center font-thai">
              <span className="font-extrabold text-neutral-800 font-kanit">รวมรายรับ</span>
              <span className="text-right font-mono font-bold text-neutral-700">{baht(takings.day.total)}</span>
              <span className="text-right font-mono font-bold text-neutral-700">{baht(takings.night.total)}</span>
              <span className="text-right font-mono font-extrabold text-admin-income">{baht(takings.all.total)}</span>
            </div>
          </>
        )}
      </div>

      {/* EXPENSES BY CATEGORY — the outgoing twin of the takings table above:
          what the month's money was spent on, split across the two shops. Only
          categories with spending in them get a row, largest first, so a month
          that bought nothing but ค่าวัตถุดิบ reads as exactly that. */}
      <div className="bg-admin-card border rounded-2xl overflow-hidden shadow-xs">
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-neutral-50 border-b">
          <span className="text-[11px] font-extrabold text-neutral-700 font-kanit">
            รายจ่ายแยกตามประเภท
          </span>
          <span className="text-[10px] font-bold text-neutral-500">{monthLabel(month)}</span>
        </div>

        {spending.rows.length > 0 ? (
          <>
            <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-1.5 px-3 py-2 bg-neutral-50 border-b text-[9.5px] font-extrabold text-neutral-500 font-kanit">
              <span>ประเภท</span>
              <span className="text-right">กลางวัน</span>
              <span className="text-right">กลางคืน</span>
              <span className="text-right">รวม</span>
            </div>
            {spending.rows.map(r => (
              <div
                key={r.category}
                className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-1.5 px-3 py-2.5 border-b border-neutral-100 text-[11px] items-center font-thai"
              >
                <span className="font-bold text-neutral-800 leading-tight">{r.category}</span>
                <span className="text-right font-mono text-neutral-600">{baht(r.day)}</span>
                <span className="text-right font-mono text-neutral-600">{baht(r.night)}</span>
                <span className="text-right font-mono font-bold text-admin-expense">{baht(r.total)}</span>
              </div>
            ))}
            <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-1.5 px-3 py-2.5 bg-admin-panel text-[11px] items-center font-thai">
              <span className="font-extrabold text-neutral-800 font-kanit">รวมรายจ่าย</span>
              <span className="text-right font-mono font-bold text-neutral-700">{baht(spending.day)}</span>
              <span className="text-right font-mono font-bold text-neutral-700">{baht(spending.night)}</span>
              <span className="text-right font-mono font-extrabold text-admin-expense">{baht(spending.total)}</span>
            </div>
          </>
        ) : (
          <p className="text-neutral-500 text-xs py-6 text-center font-medium font-thai">
            ยังไม่มีรายจ่ายในเดือน {monthLabel(month)}
          </p>
        )}
      </div>

      {/* HISTORY — replaces the old ประวัติการใช้จ่าย, now with income in it.
          There is deliberately no totals strip here: the dashboard's own
          สรุปยอดรายเดือน block already carries รายรับ / รายจ่าย / กำไรสุทธิ, and two
          copies of the same three numbers drift apart in the reader's head. */}
      <div className="flex justify-between items-center gap-2 pl-1 flex-wrap">
        <h3 className="font-extrabold text-base font-kanit text-neutral-800 whitespace-nowrap">
          ประวัติรายรับ-รายจ่าย
        </h3>
        <span className="text-[11px] font-bold text-neutral-500">{monthLabel(month)}</span>
      </div>

      {/* ประเภท filter: read the takings and the outgoings on their own. */}
      <div className="flex gap-1 bg-admin-bar rounded-full p-0.5 text-[10px] font-bold">
        {KIND_FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => setKind(f.id)}
            className={`flex-1 px-3 py-1.5 rounded-full transition ${
              kind === f.id
                ? 'bg-admin-tab text-admin-tab-ink shadow-sm'
                : 'text-admin-tab-idle hover:text-admin-tab-hover'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ROWS — billed income is one line per day per shop, never bill by bill.
          Every hand-keyed entry, รายรับ or รายจ่าย, keeps its own row so its
          note and its delete survive. */}
      <div className="bg-admin-card border rounded-2xl overflow-hidden shadow-xs">
        <div className="grid grid-cols-[1fr_1.1fr_0.8fr_1.4fr_0.9fr_auto] gap-1.5 px-3 py-2 bg-neutral-50 border-b text-[9.5px] font-extrabold text-neutral-500 font-kanit">
          <span>วันที่</span>
          <span>ร้าน</span>
          <span>ประเภท</span>
          <span>รายการ</span>
          <span className="text-right">จำนวนเงิน ฿</span>
          <span className="w-6" />
        </div>

        {pageRows.length > 0 ? (
          pageRows.map(r => (
            <div
              key={r.key}
              className="grid grid-cols-[1fr_1.1fr_0.8fr_1.4fr_0.9fr_auto] gap-1.5 px-3 py-2.5 border-b border-neutral-100 last:border-0 text-[10px] items-center font-thai"
            >
              <span className="font-mono text-neutral-600">{shortDate(r.date)}</span>
              <span className="font-bold text-neutral-800 leading-tight">{shopLabel(r.shop)}</span>
              <span className={r.kind === 'income' ? 'text-admin-income font-bold' : 'text-admin-expense font-bold'}>
                {r.kind === 'income' ? 'รายรับ' : 'รายจ่าย'}
              </span>
              <span className="text-neutral-500 leading-tight truncate" title={r.note || r.label}>
                {r.label}
                {r.note && <span className="block text-[9px] text-neutral-400 truncate">{r.note}</span>}
              </span>
              <span className="text-right font-mono font-bold text-neutral-800">{baht(r.amount)}</span>
              {/* Anything typed by hand can be removed; the day's rolled-up
                  takings cannot — that money belongs to the bills. */}
              {r.id ? (
                <button
                  onClick={() => onDeleteEntry?.(r.id, r.label, r.amount, r.kind)}
                  className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-500/10 rounded-lg transition"
                  title="ลบรายการ"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              ) : (
                <span className="w-6" />
              )}
            </div>
          ))
        ) : (
          <p className="text-neutral-500 text-xs py-6 text-center font-medium">
            {kind === 'income'
              ? `ยังไม่มีรายรับในเดือน ${monthLabel(month)}`
              : kind === 'expense'
                ? `ยังไม่มีรายจ่ายในเดือน ${monthLabel(month)}`
                : `ยังไม่มีข้อมูลในเดือน ${monthLabel(month)}`}
          </p>
        )}

        {/* PAGING — only when there is a second page. The footer below still
            totals the whole list, not just the rows on this page. */}
        {pageCount > 1 && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-neutral-50 border-t text-[10px] font-bold">
            <button
              onClick={() => setPage(safePage - 1)}
              disabled={safePage === 0}
              className="px-3 py-1.5 rounded-lg border border-neutral-200 text-neutral-600 bg-admin-field transition hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-admin-field"
            >
              ‹ ก่อนหน้า
            </button>
            <span className="text-neutral-500 font-mono tabular-nums text-center">
              {firstRow + 1}–{firstRow + pageRows.length} จาก {visible.length}
            </span>
            <button
              onClick={() => setPage(safePage + 1)}
              disabled={safePage >= pageCount - 1}
              className="px-3 py-1.5 rounded-lg border border-neutral-200 text-neutral-600 bg-admin-field transition hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-admin-field"
            >
              ถัดไป ›
            </button>
          </div>
        )}

        {/* Adding takings to outgoings would be a meaningless number, so the
            unfiltered view foots with the month's profit instead of a sum. */}
        {visible.length > 0 && (
          <div className="flex justify-between items-center px-3 py-2.5 bg-admin-panel text-xs font-extrabold font-kanit">
            <span className="text-neutral-600">
              {kind === 'income' ? 'รวมรายรับ' : kind === 'expense' ? 'รวมรายจ่าย' : 'กำไรสุทธิทั้งเดือน'}
            </span>
            <span className={`font-mono ${kind === 'all' && totals.profit < 0 ? 'text-admin-expense' : 'text-neutral-800'}`}>
              ฿{baht(kind === 'all' ? totals.profit : visible.reduce((n, r) => n + r.amount, 0))}
            </span>
          </div>
        )}
      </div>

      {/* Export always covers the WHOLE month shown above, never the filtered
          view — the workbook is the month's book, not a screenshot of the list. */}
      <button
        onClick={handleExport}
        className="w-full bg-admin-cta hover:bg-admin-cta-hover text-admin-cta-ink font-bold py-3 rounded-2xl transition flex items-center justify-center gap-2 font-kanit"
      >
        <FileSpreadsheet className="w-4 h-4" />
        ส่งออกข้อมูล {monthLabel(month)}
      </button>
    </div>
  );
}

export default OwnerSummary;
