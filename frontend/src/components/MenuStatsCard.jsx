import React, { useState, useMemo, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import { formatThaiDate } from '../expenses';
import { workdayKey } from '../shift';
import MenuPresetManager from './MenuPresetManager';
import { menuStats, presetDishNames, availableMonths } from '../stats';
import { monthLabel, baht } from '../dashboard-format';

const GROUPS = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'food', label: 'อาหาร' },
  { id: 'drink', label: 'น้ำ' },
  // เฉพาะเมนู is not a third kind of dish — it is "only the ones in this group",
  // and it brings its own preset dropdown with it.
  { id: 'preset', label: 'เฉพาะเมนู' }
];

// Which slice of time สถิติเมนู counts. Opens on รายวัน / today, because the
// question this table is usually opened to answer is "วันนี้ขายอะไรไปบ้าง".
const STAT_PERIODS = [
  { id: 'day', label: 'รายวัน' },
  { id: 'month', label: 'รายเดือน' },
  { id: 'year', label: 'รายปี' }
];

// How many dishes the stats table shows at once. A year of trade is a couple of
// hundred rows, and a table that long is scrolled past rather than read.
const STAT_PAGE_SIZE = 20;

// สถิติเมนู — per-dish sales for a chosen day / month / year, with the เฉพาะเมนู
// preset filter. Shared by the owner's dashboard and the ผู้จัดการคลัง's
// ดูยอดขาย tab.
//
//   shift          — 'all' | 'day' | 'night', owned by the caller.
//   setMenuPresets — omit to make presets pick-only (no แก้ไข preset button):
//                    only an owner may write them.
//   scopeNames     — omit for every dish. A Set of dish names locks the whole
//                    table to those dishes, presets included (a preset can only
//                    narrow it further); null means that set is still loading.
//   presetOnly     — true locks the card to เฉพาะเมนู and hides the
//                    ทั้งหมด / อาหาร / น้ำ tabs.
function MenuStatsCard({ orders, expenses, menu, shift, menuPresets, setMenuPresets, showToast, scopeNames, presetOnly = false }) {
  const [group, setGroup] = useState(presetOnly ? 'preset' : 'all');
  const [sortBy, setSortBy] = useState('qty');

  // Its own period, independent of the dashboard's trend chart: one is "how is
  // the shop doing over time", the other is "what sold on this day".
  const [statPeriod, setStatPeriod] = useState('day'); // day | month | year
  const [statDay, setStatDay] = useState(() => workdayKey());
  const [statMonth, setStatMonth] = useState(() => workdayKey().slice(0, 7));
  const [statYear, setStatYear] = useState(() => workdayKey().slice(0, 4));
  // Which page of the table is showing, 0-based. Reset by the effect below
  // whenever the filters change — page 3 of the old list is a page nobody asked
  // for once the question changed.
  const [page, setPage] = useState(0);
  // Which saved กลุ่มเมนู the เฉพาะเมนู tab is showing, and whether the editor
  // panel is open. '' = none picked yet, which is what the dropdown opens on.
  const [presetId, setPresetId] = useState('');
  const [showPresets, setShowPresets] = useState(false);
  const canEditPresets = typeof setMenuPresets === 'function';

  const today = workdayKey();

  // Every 'YYYY-MM' with trade in it, newest first, plus the current month.
  const months = useMemo(() => availableMonths(orders, expenses), [orders, expenses]);

  // The saved กลุ่มเมนู, and the one currently selected. A preset whose dishes
  // have all been deleted resolves to an empty name set — an honestly empty
  // table, not a silent fall back to every dish.
  const presetList = Array.isArray(menuPresets) ? menuPresets : [];
  const activePreset = presetList.find((p) => p.id === presetId) || null;
  const presetNames = useMemo(
    () => (activePreset ? presetDishNames(menu, activePreset.menuIds) : null),
    [menu, activePreset]
  );

  // A month that scrolls out of the list — data cleared — falls back to the
  // newest rather than pointing at nothing.
  const statMonthKey = months.includes(statMonth) ? statMonth : (months[0] || today.slice(0, 7));

  // The years those months fall in, newest first. Derived rather than counted
  // from a fixed range, so the dropdown never offers a year the shop did not
  // trade in — and always offers this one, since availableMonths carries it.
  const statYears = useMemo(
    () => [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse(),
    [months]
  );
  const statYearKey = statYears.includes(statYear) ? statYear : (statYears[0] || today.slice(0, 4));

  // 'YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' — all three are prefixes of a day key, so
  // menuStats needs no third code path to count a whole year.
  const statKey =
    statPeriod === 'day' ? statDay : statPeriod === 'year' ? statYearKey : statMonthKey;
  // เฉพาะเมนู with nothing chosen yet has no question to answer, so it asks for
  // a preset instead of quietly showing the unfiltered table.
  const awaitingPreset = group === 'preset' && !activePreset;
  const scopeLoading = scopeNames === null;

  // The dish names the table may show: the caller's scope, narrowed by the
  // chosen preset under เฉพาะเมนู. undefined = no limit at all.
  const names = useMemo(() => {
    const preset = group === 'preset' ? presetNames : null;
    if (!scopeNames) return preset || undefined;
    if (!preset) return scopeNames;
    return new Set([...preset].filter((n) => scopeNames.has(n)));
  }, [group, presetNames, scopeNames]);

  const rows = useMemo(() => {
    if (awaitingPreset || scopeLoading) return [];
    return menuStats(orders, menu, {
      shift,
      // เฉพาะเมนู is a dish filter, not a food/drink one — the group stays 'all'
      // and the preset's names do the narrowing.
      group: group === 'preset' ? 'all' : group,
      sortBy,
      periodKey: statKey,
      names
    });
  }, [orders, menu, shift, group, sortBy, statKey, names, awaitingPreset, scopeLoading]);

  // --- Paging the stats table ----------------------------------------------
  // Change the question and you are looking at a new list, so go back to its
  // first page. (Sorting counts: page 3 of "ขายดีที่สุด" is a different set of
  // dishes from page 3 of "ยอดขายรวมมากสุด".)
  useEffect(() => {
    setPage(0);
  }, [shift, group, sortBy, statKey, presetId]);

  const pageCount = Math.max(1, Math.ceil(rows.length / STAT_PAGE_SIZE));
  // Clamped rather than trusted: the list can shrink under a page that is
  // already open — a bill cancelled on another device, an order coming in.
  const safePage = Math.min(page, pageCount - 1);
  const firstRow = safePage * STAT_PAGE_SIZE;
  const pageRows = useMemo(
    () => rows.slice(firstRow, firstRow + STAT_PAGE_SIZE),
    [rows, firstRow]
  );

  return (
    <>
    {/* MENU STATS */}
    <div className="bg-admin-card border rounded-2xl overflow-hidden shadow-xs">
      <div className="p-3.5 pb-2.5 space-y-2.5">
        {/* Heading + period toggle on one line: the toggle is what the heading
            means ("สถิติเมนู ของวันไหน"), so it reads as part of it. */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="font-extrabold text-base font-kanit text-neutral-800">สถิติเมนู</h3>
          <div className="flex gap-1 bg-neutral-100 rounded-xl p-1 text-[10px] font-bold">
            {STAT_PERIODS.map(p => (
              <button
                key={p.id}
                onClick={() => setStatPeriod(p.id)}
                className={`px-3 py-1.5 rounded-lg transition ${
                  p.id === statPeriod ? 'bg-admin-field text-neutral-800 shadow-xs' : 'text-neutral-500'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* The picker the toggle asks for: a full date in รายวัน, month + year
            in รายเดือน, the year alone in รายปี. text-neutral-800 on the date
            box because it carries its own background — an inherited colour
            goes invisible at night. */}
        {statPeriod === 'year' ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-400 font-bold shrink-0">ปี</span>
            <select
              value={statYearKey}
              onChange={e => setStatYear(e.target.value)}
              className="flex-1 min-w-0 border rounded-xl py-1.5 px-2 text-[11px] font-bold text-neutral-600 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              {/* พ.ศ., the way the owner reads a year. */}
              {statYears.map(y => (
                <option key={y} value={y}>{Number(y) + 543}</option>
              ))}
            </select>
          </div>
        ) : statPeriod === 'day' ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-400 font-bold shrink-0">วันที่</span>
            <input
              type="date"
              value={statDay}
              max={today}
              onChange={e => setStatDay(e.target.value || today)}
              className="flex-1 min-w-0 border rounded-xl py-1.5 px-2 text-[11px] font-bold text-neutral-800 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500"
            />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-400 font-bold shrink-0">เดือน</span>
            {/* A dropdown of months rather than <input type="month">: that
                input has no picker at all in Safari (desktop and iOS), where
                it degrades to a bare text box. Each option already reads as
                เดือน + ปี — "กันยายน 2569". */}
            <select
              value={statMonthKey}
              onChange={e => setStatMonth(e.target.value)}
              className="flex-1 min-w-0 border rounded-xl py-1.5 px-2 text-[11px] font-bold text-neutral-600 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              {months.map(m => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          </div>
        )}
        {statPeriod === 'day' && (
          <p className="text-[10px] font-bold text-neutral-500 font-thai -mt-1">
            {formatThaiDate(statDay)}
            {statDay === today && ' · วันนี้'}
          </p>
        )}

        {!presetOnly && (
          <div className="flex gap-1 bg-neutral-100 rounded-xl p-1 text-[11px] font-bold">
            {GROUPS.map(g => (
              <button
                key={g.id}
                onClick={() => setGroup(g.id)}
                className={`flex-1 py-1.5 rounded-lg transition ${g.id === group ? 'bg-admin-field text-neutral-800 shadow-xs' : 'text-neutral-500'}`}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}

        {/* เฉพาะเมนู brings its own row: pick a saved กลุ่มเมนู, or go and build
            one. The dropdown lists nothing but its own placeholder until a
            preset exists — which is the empty state, said out loud. */}
        {group === 'preset' && (
          <div className="flex items-center gap-2">
            <select
              value={presetId}
              onChange={e => setPresetId(e.target.value)}
              className="flex-1 min-w-0 border rounded-xl py-1.5 px-2 text-[11px] font-bold text-neutral-600 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              <option value="">เลือก preset</option>
              {presetList.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {canEditPresets && (
              <button
                onClick={() => setShowPresets(true)}
                className="shrink-0 bg-admin-cta hover:bg-admin-cta-hover text-admin-cta-ink font-bold py-1.5 px-3 rounded-xl transition font-kanit flex items-center justify-center gap-1 text-[11px]"
              >
                <Pencil className="w-3.5 h-3.5 flex-shrink-0" />
                แก้ไข preset
              </button>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-400 font-bold shrink-0">เรียงตาม</span>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="flex-1 border rounded-xl py-1.5 px-2 text-[11px] font-bold text-neutral-600 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500"
          >
            <option value="qty">จำนวนจานที่ขายได้มากสุด</option>
            <option value="revenue">ยอดขายรวมมากสุด</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-[2fr_1fr_1fr] gap-2 px-3.5 py-2 bg-neutral-50 border-y text-[10px] font-extrabold text-neutral-500 font-kanit">
        <span>ชื่อเมนู</span>
        <span className="text-right">จำนวนที่ขายได้</span>
        <span className="text-right">ยอดขายรวม</span>
      </div>

      {pageRows.length > 0 ? (
        pageRows.map((r, i) => (
          <div
            key={r.name}
            className="grid grid-cols-[2fr_1fr_1fr] gap-2 px-3.5 py-2.5 border-b border-neutral-100 last:border-0 text-[11px] items-center font-thai"
          >
            {/* The rank is the table's whole point once it is paged: without
                it, row 1 of page 2 looks like the best seller. It keeps
                counting across pages because the sort does. */}
            <span className="font-bold text-neutral-800 flex items-baseline gap-1.5 min-w-0">
              <span className="text-[9.5px] font-mono text-neutral-400 shrink-0 tabular-nums">
                {firstRow + i + 1}.
              </span>
              <span className="truncate">{r.name}</span>
            </span>
            <span className="text-right font-mono text-neutral-700">{r.qty}</span>
            <span className="text-right font-mono font-bold text-neutral-800">
              {baht(r.revenue)} บาท
            </span>
          </div>
        ))
      ) : (
        <p className="text-neutral-400 text-xs py-6 text-center font-medium font-thai">
          {scopeLoading
            ? 'กำลังโหลดรายการในคลัง…'
            : awaitingPreset
              ? 'เลือก preset เพื่อดูสถิติเฉพาะกลุ่มเมนูนั้น'
              : 'ยังไม่มียอดขายในช่วงที่เลือก'}
        </p>
      )}

      {/* PAGING — only when there is a second page to go to. It says which
          rows these are out of how many, because "หน้า 2/5" does not answer
          "ยังเหลืออีกกี่เมนู". */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-neutral-50 border-t text-[10px] font-bold">
          <button
            onClick={() => setPage(safePage - 1)}
            disabled={safePage === 0}
            className="px-3 py-1.5 rounded-lg border border-neutral-200 text-neutral-600 bg-admin-field transition hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-admin-field"
          >
            ‹ ก่อนหน้า
          </button>
          <span className="text-neutral-500 font-mono tabular-nums text-center">
            {firstRow + 1}–{firstRow + pageRows.length} จาก {rows.length}
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
    </div>

    {/* แก้ไข preset — the same kind of panel as แก้ไขเมนูเสริม in จัดการเมนู,
        over the dashboard rather than in a tab of its own: presets exist only
        to be read here, so this is where they are written. */}
    {showPresets && canEditPresets && (
      <MenuPresetManager
        presets={presetList}
        menu={menu}
        onSave={(next) => {
          setMenuPresets(next);
          // A preset that was just deleted must not stay selected behind the
          // panel — the table would keep filtering by a group that is gone.
          if (presetId && !next.some((p) => p.id === presetId)) setPresetId('');
        }}
        onClose={() => setShowPresets(false)}
        showToast={showToast}
      />
    )}
    </>
  );
}

export default MenuStatsCard;
