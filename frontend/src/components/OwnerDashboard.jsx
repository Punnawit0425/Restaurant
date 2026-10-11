import React, { useState, useMemo, useRef } from 'react';
import { TrendingUp, TrendingDown, Wallet, Coins, Banknote, Landmark, Smartphone } from 'lucide-react';
import { formatThaiDate, formatThaiDateWithWeekday, THAI_MONTHS_FULL } from '../expenses';
import { workdayKey } from '../shift';
import MenuStatsCard from './MenuStatsCard';
import { monthLabel, baht, SHIFT_TABS } from '../dashboard-format';
import {
  dayTotals,
  dayTakingsByMethod,
  dailySeries,
  monthlySeries,
  percentChange,
  summaryRows,
  summaryTotals,
  availableMonths
} from '../stats';

// The chart's three marks. Sales and profit are both in baht, so they share ONE
// y-axis — never a second scale.
//
// Sales is the categorical blue. Profit is NOT a third category: it is one
// series whose colour states its sign — green above the break-even line, red
// below it. Position carries that sign too (a loss grows downward), which is
// what keeps the chart readable for the red/green colour-blind, for whom these
// two hues are the hardest pair there is.
//
// The hues live in index.css (--c-chart-*) because they have to be re-picked for
// the night theme: the day steps are chosen against a white card and go muddy on
// a near-black one. These string forms are for inline `style` only — SVG
// presentation attributes don't accept var(), so the chart marks below reach the
// same variables through stroke-/fill- classes.
const C_REVENUE = 'var(--c-chart-revenue)';
const C_PROFIT = 'var(--c-chart-profit)';
const C_LOSS = 'var(--c-chart-loss)';

const RANGES = [
  { id: 'week', label: 'สัปดาห์' },
  { id: 'month', label: 'เดือน' },
  { id: 'year', label: 'ปี' }
];

// A round gridline interval (1 / 2 / 2.5 / 5 × 10^n) at or above `raw`, so the
// axis labels are numbers a person would actually write down.
function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = Math.max(raw, 1) / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * pow;
}

// One profit bar, grown from the break-even line with its DATA end rounded (4px,
// or half the bar when it is thinner than that) and its baseline end square. The
// shape is the point: a bar reading upward is a profit and one reading downward
// is a loss, which stays true with the colour taken away.
//
// A value of almost exactly zero would otherwise render as an invisible sliver,
// so it draws as a hairline sitting on the line — "traded, broke even", which is
// a different fact from "no trade at all" (no bar).
function barPath(cx, w, yZero, yValue, rMax = 4) {
  const half = w / 2;
  const [l, r] = [cx - half, cx + half];
  const h = Math.abs(yZero - yValue);
  if (h < 0.6) return `M${l},${yZero} L${r},${yZero}`;
  const rad = Math.min(rMax, half, h);
  // dir is +1 when the rounded end is ABOVE the baseline (a profit), -1 below.
  const dir = yValue <= yZero ? 1 : -1;
  const near = yValue + rad * dir;
  return [
    `M${l},${yZero}`,
    `L${l},${near}`,
    `Q${l},${yValue} ${l + rad},${yValue}`,
    `L${r - rad},${yValue}`,
    `Q${r},${yValue} ${r},${near}`,
    `L${r},${yZero}`,
    'Z',
  ].join(' ');
}

// Axis bounds. The TOP snaps out to a whole step so the highest gridline is a
// round number. The BOTTOM is fitted to the deepest loss plus a little air, and
// deliberately NOT snapped: a single -2,000 day under a month of +50,000 ones
// would otherwise reserve a whole -20,000 band, and a fifth of the chart would
// be empty space no data ever reaches.
//
// Zero still lands exactly on a gridline whichever way the range falls, because
// the ticks are multiples of the step and zero is one of them — which is what
// makes a loss legible against break-even.
function axisBounds(points) {
  const rawHi = Math.max(1, ...points.map((p) => Math.max(p.revenue, p.profit)));
  const rawLo = Math.min(0, ...points.map((p) => p.profit));
  const step = niceStep((rawHi - rawLo) / 4);
  const hi = Math.ceil(rawHi / step) * step;
  const lo = rawLo < 0 ? rawLo * 1.15 : 0;
  return { lo, hi: hi === lo ? lo + step : hi, step };
}

// One KPI tile. `delta` is a percent vs the previous day, or null when there is
// no baseline — in which case we say so rather than printing a fake +100%.
function StatTile({ label, value, delta, tone, Icon }) {
  const up = delta != null && delta >= 0;
  return (
    <div className="bg-admin-card border rounded-2xl p-3.5 shadow-xs">
      <span className={`text-[10px] font-extrabold font-kanit px-2 py-1 rounded-lg ${tone}`}>
        {label}
      </span>
      <div className="flex items-baseline gap-1 mt-2">
        <Icon className="w-4 h-4 text-neutral-400 shrink-0" />
        <span className="font-mono text-lg font-extrabold text-neutral-800 leading-none">
          {baht(value)}
        </span>
        <span className="text-[10px] text-neutral-400 font-medium">บาท</span>
      </div>
      {delta != null ? (
        <span
          className={`text-[10px] font-bold mt-1 flex items-center gap-0.5 ${up ? 'text-green-700' : 'text-red-600'}`}
        >
          {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {up ? '+' : ''}{delta.toFixed(1)}%
        </span>
      ) : (
        <span className="text-[10px] text-neutral-400 font-medium mt-1 block">
          ไม่มีข้อมูลวันก่อนหน้า
        </span>
      )}
    </div>
  );
}

// One takings tile: where today's money physically landed (till / bank / wallet).
// Simpler than StatTile — no day-over-day delta, since "which pocket" is a
// snapshot, not a trend.
function TakingsTile({ label, value, tone, Icon }) {
  return (
    <div className="bg-admin-card border rounded-2xl p-3.5 shadow-xs">
      <span className={`inline-flex items-center gap-1 text-[10px] font-extrabold font-kanit px-2 py-1 rounded-lg ${tone}`}>
        <Icon className="w-3 h-3" />
        {label}
      </span>
      <div className="flex items-baseline gap-1 mt-2">
        <span className="font-mono text-lg font-extrabold text-neutral-800 leading-none">
          {baht(value)}
        </span>
        <span className="text-[10px] text-neutral-400 font-medium">บาท</span>
      </div>
    </div>
  );
}

// Two-series line chart on a single shared axis, with a hover crosshair.
// Exported (as well as used below) so the chart can be rendered on its own at
// any range when checking how it actually looks.
export function TrendChart({ points, range }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  // A touch more room than the plot strictly needs: air on all four sides is
  // most of what separates a chart that looks considered from one that looks
  // cramped. padB carries the date row, padL the widest baht figure.
  const W = 360;
  const H = 196;
  const padL = 46;
  const padR = 12;
  const padT = 16;
  const padB = 28;

  // The axis has to reach below zero when a day loses money — clamping a loss to
  // the baseline would draw it exactly like breaking even.
  const { lo, hi, step } = axisBounds(points);

  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // A BAND scale, not an edge-to-edge one: every point owns a slot of the plot
  // and its bar is centred in it. Spreading the points edge-to-edge (the shape a
  // pure line chart wants) would hang the first and last bars half off the axis.
  const band = plotW / Math.max(points.length, 1);
  const x = (i) => padL + (i + 0.5) * band;
  const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Capped at 22px so a 7-day week draws bars, not slabs, and never wider than
  // 62% of its slot — a bar that fills its band leaves no air and the row reads
  // as a solid block. The 2px minimum gap is the surface doing the separating.
  const barW = Math.max(2, Math.min(22, band * 0.62, band - 2));
  const yZero = y(0);

  const path = (key) => points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[key])}`).join(' ');

  // Every multiple of the step that falls inside the axis. Started from the
  // first one at or above `lo` rather than from `lo` itself, which is no longer
  // a multiple (see axisBounds).
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step / 2; t += step) ticks.push(t);

  // Label every point when they fit, otherwise thin them out to ~6.
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  // Day-of-month alone restarts at 1 mid-axis, so carry the month with it.
  const shortLabel = (p) => {
    if (range === 'year') return THAI_MONTHS_FULL[p.date.getMonth()].slice(0, 3);
    return `${p.date.getDate()}/${p.date.getMonth() + 1}`;
  };

  const onMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Client px -> viewBox units, since the SVG scales to its container. Which
    // BAND the finger is over, so the whole slot is the hit target rather than
    // the bar's own width — the thin 30-day bars are far too small to aim at.
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((vx - padL) / band);
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  const hp = hover != null ? points[hover] : null;

  return (
    // The SVG scales to its container, and everything inside it — line weights,
    // axis numbers, markers — scales with it. In the widened desktop shell that
    // blew the chart up to full monitor width with huge numbers on it, so the
    // container is capped: a phone is unaffected (its shell is narrower than
    // max-w-md anyway) and a desktop gets a slightly larger chart, not a poster.
    // Widen/narrow the chart by changing THIS max-width, nothing else.
    <div className="relative w-full max-w-md lg:max-w-lg mx-auto">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          {/* A bar is one colour, lifted a little at its data end. Not a second
              encoding — the shift is far too small to read as a value — just the
              difference between a flat block of ink and something with a surface
              to it. Same idea on both signs, so neither reads as the louder one. */}
          <linearGradient id="tc-profit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: C_PROFIT, stopOpacity: 0.88 }} />
            <stop offset="100%" style={{ stopColor: C_PROFIT, stopOpacity: 1 }} />
          </linearGradient>
          <linearGradient id="tc-loss" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" style={{ stopColor: C_LOSS, stopOpacity: 0.88 }} />
            <stop offset="100%" style={{ stopColor: C_LOSS, stopOpacity: 1 }} />
          </linearGradient>
        </defs>

        {/* The slot under the finger, lit before anything is drawn on it. A
            whole-band wash reads as "this column" far better than the crosshair
            alone, and it is what makes the thin 30-day bars feel aimable. */}
        {hp && (
          <rect
            x={padL + hover * band}
            y={padT}
            width={band}
            height={plotH}
            rx="3"
            className="fill-chart-grid"
            opacity="0.55"
          />
        )}

        {/* gridlines + y labels */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="stroke-chart-grid" strokeWidth="1" />
            <text
              x={padL - 8}
              y={y(t) + 2.8}
              textAnchor="end"
              fontSize="7.5"
              className="fill-chart-axis"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {baht(t)}
            </text>
          </g>
        ))}

        {/* Break-even. Always drawn, not only when the range dips below it: it is
            the line every profit bar is grown from, so it is structure rather
            than an annotation that appears on bad days. */}
        <line x1={padL} x2={W - padR} y1={yZero} y2={yZero} className="stroke-chart-zero" strokeWidth="1.25" />

        {/* x labels */}
        {points.map((p, i) =>
          i % labelEvery === 0 ? (
            <text key={p.key} x={x(i)} y={H - 9} textAnchor="middle" fontSize="7.5" className="fill-chart-axis">
              {shortLabel(p)}
            </text>
          ) : null
        )}

        {/* PROFIT — bars from the break-even line: green above it, red below.
            Drawn before the sales line so the line reads on top of them. */}
        {points.map((p, i) => {
          const flat = Math.abs(y(p.profit) - yZero) < 0.6;
          const loss = p.profit < 0;
          return (
            <path
              key={p.key}
              d={barPath(x(i), barW, yZero, y(p.profit))}
              fill={flat ? 'none' : `url(#tc-${loss ? 'loss' : 'profit'})`}
              className={loss ? 'stroke-chart-loss' : 'stroke-chart-profit'}
              // The stroke only matters for the break-even hairline, where there
              // is no area to fill.
              strokeWidth={flat ? 1.5 : 0}
              strokeLinecap="round"
            />
          );
        })}

        {/* SALES — one 2px line over the bars, finished with a dot on the newest
            point so the eye knows which end is "now". */}
        <path d={path('revenue')} fill="none" className="stroke-chart-revenue" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.length > 0 && (
          <circle
            cx={x(points.length - 1)}
            cy={y(points[points.length - 1].revenue)}
            r="3.25"
            className="fill-chart-revenue stroke-chart-surface"
            strokeWidth="2"
          />
        )}

        {/* crosshair + marker, drawn with a surface ring so it reads over the line */}
        {hp && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} className="stroke-chart-cross" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(hp.revenue)} r="4.5" className="fill-chart-revenue stroke-chart-surface" strokeWidth="2" />
          </g>
        )}
      </svg>

      {/* tooltip — a small card, its numbers in a right-aligned column so the
          three values line up instead of ragging out after their labels. */}
      {hp && (
        <div
          className={`absolute top-0 bg-admin-card border border-line rounded-xl px-3 py-2 text-[10px] shadow-lg pointer-events-none font-thai min-w-[132px] ${
            hover > points.length / 2 ? 'left-0' : 'right-0'
          }`}
        >
          <span className="font-extrabold text-neutral-700 block pb-1.5 mb-1.5 border-b border-neutral-100">
            {range === 'year'
              ? `${THAI_MONTHS_FULL[hp.date.getMonth()]} ${hp.date.getFullYear() + 543}`
              : formatThaiDateWithWeekday(hp.key)}
          </span>
          <span className="flex items-center gap-1.5 text-neutral-600 leading-5">
            <span className="w-2.5 h-[2.5px] rounded-full shrink-0" style={{ background: C_REVENUE }} />
            ยอดขาย
            <b className="font-mono ml-auto tabular-nums text-neutral-800">{baht(hp.revenue)}</b>
          </span>
          {/* Not a mark on the chart — but it is the other half of the bar's
              arithmetic, and "why was this day red" has no answer without it. */}
          <span className="flex items-center gap-1.5 text-neutral-500 leading-5">
            <span className="w-2.5 shrink-0" />
            รายจ่าย
            <b className="font-mono ml-auto tabular-nums text-neutral-600">{baht(hp.expense)}</b>
          </span>
          {/* Named by its sign, not only coloured by it — the word is what a
              reader who cannot tell the two hues apart goes by. */}
          <span className="flex items-center gap-1.5 text-neutral-600 leading-5 pt-1 mt-1 border-t border-neutral-100">
            <span
              className="w-2.5 h-2.5 rounded-[2px] shrink-0"
              style={{ background: hp.profit < 0 ? C_LOSS : C_PROFIT }}
            />
            {hp.profit < 0 ? 'ขาดทุน' : 'กำไร'}
            <b className="font-mono ml-auto tabular-nums font-extrabold text-neutral-800">
              {baht(Math.abs(hp.profit))}
            </b>
          </span>
        </div>
      )}
    </div>
  );
}

function OwnerDashboard({ orders, expenses, menu, menuPresets, setMenuPresets, showToast }) {
  const [shift, setShift] = useState('all');
  const [range, setRange] = useState('month');

  // The WORKING day, so "วันนี้" here means the same stretch of time the shop
  // trades in: 06:00 today → 06:00 tomorrow. The night side's bills
  // therefore stay on tonight's total after midnight, and the KPI row resets at
  // 06:00 rather than while the bar is still open.
  const today = workdayKey();

  // Which working day the six cards at the top reflect. Defaults to the day in
  // progress; the picker lets the owner read any past day back. The trend chart
  // and month summary below keep their own ranges — only the KPI + takings cards
  // follow this selector.
  const [cardDate, setCardDate] = useState(today);
  // Never point past the day in progress: there is no trade ahead of "now", and
  // a working day only closes at 06:00, so tomorrow is never a valid choice.
  const dateKey = cardDate > today ? today : cardDate;
  const isToday = dateKey === today;

  // The working day immediately before the selected one, for the % comparison
  // line under each KPI. Read off a noon Date so the -6h working-day shift can
  // never tip the key across a timezone boundary.
  const prevDayKey = useMemo(() => {
    const d = new Date(`${dateKey}T12:00:00`);
    d.setDate(d.getDate() - 1);
    return workdayKey(d);
  }, [dateKey]);

  const todayTotals = useMemo(
    () => dayTotals(orders, expenses, shift, dateKey),
    [orders, expenses, shift, dateKey]
  );
  const prevTotals = useMemo(
    () => dayTotals(orders, expenses, shift, prevDayKey),
    [orders, expenses, shift, prevDayKey]
  );

  // Where the day's takings landed: cash in the till, PromptPay to the shop bank,
  // or คนละครึ่ง into the เป๋าตัง wallet.
  const takings = useMemo(
    () => dayTakingsByMethod(orders, shift, dateKey),
    [orders, shift, dateKey]
  );

  const points = useMemo(() => {
    if (range === 'week') return dailySeries(orders, expenses, shift, 7);
    if (range === 'month') return dailySeries(orders, expenses, shift, 30);
    return monthlySeries(orders, expenses, shift, 12);
  }, [orders, expenses, shift, range]);

  // Every 'YYYY-MM' with trade in it, newest first, plus the current month, for
  // the สรุปยอดรายเดือน dropdown below.
  const summaryMonths = useMemo(() => availableMonths(orders, expenses), [orders, expenses]);

  // Month summary, split day vs night with a combined total — moved here from
  // the สรุปยอด tab so it sits directly under today's income/expense cards.
  // Always shows both shifts (that's the whole point of the table), so it ignores
  // the shift selector above; the month is chosen with its own dropdown.
  const [summaryMonth, setSummaryMonth] = useState(() => today.slice(0, 7));
  // If the picked month scrolls out of the available list (e.g. data cleared),
  // fall back to the newest month so the table never renders a stale/empty key.
  const monthKey = summaryMonths.includes(summaryMonth)
    ? summaryMonth
    : (summaryMonths[0] || today.slice(0, 7));
  const monthRows = useMemo(
    () => summaryRows(orders, expenses, monthKey),
    [orders, expenses, monthKey]
  );
  const monthTotals = useMemo(() => summaryTotals(monthRows), [monthRows]);
  const monthByShift = useMemo(() => {
    const make = (id) => summaryTotals(monthRows.filter((r) => r.shop === id));
    return { day: make('day'), night: make('night') };
  }, [monthRows]);

  return (
    <div className="space-y-4">

      {/* SHIFT SPLIT — every number below is scoped to this */}
      <div className="flex gap-1.5 bg-neutral-100 rounded-xl p-1 text-[11px] font-bold">
        {SHIFT_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setShift(t.id)}
            className={`flex-1 py-2 rounded-lg transition ${t.id === shift ? 'bg-admin-field text-neutral-800 shadow-xs' : 'text-neutral-500'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* DATE PICKER — which working day the six cards below reflect. Only these
          KPI + takings cards follow it; the trend chart and month summary keep
          their own ranges. */}
      <div className="flex items-center justify-between gap-2 bg-admin-card border rounded-2xl px-3 py-2.5 shadow-xs">
        <div className="min-w-0">
          <span className="text-[10px] font-extrabold text-neutral-400 uppercase tracking-wider font-kanit block">
            ข้อมูลของวันที่
          </span>
          <span className="text-xs font-bold text-neutral-700 font-thai truncate block">
            {isToday ? `วันนี้ · ${formatThaiDate(dateKey)}` : formatThaiDate(dateKey)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* One tap back to the day in progress after browsing an old date. */}
          {!isToday && (
            <button
              type="button"
              onClick={() => setCardDate(today)}
              className="text-[10px] font-bold text-amber-700 hover:underline"
            >
              กลับเป็นวันนี้
            </button>
          )}
          {/* max=today: a working day only closes at 06:00, so tomorrow is never
              a valid pick. text-neutral-800 so the field's own value stays legible
              against its background at night. */}
          <input
            type="date"
            value={dateKey}
            max={today}
            onChange={(e) => setCardDate(e.target.value || today)}
            className="border rounded-xl p-2 bg-admin-field text-neutral-800 focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold text-xs"
          />
        </div>
      </div>

      {/* KPI TILES — the % line under each compares the selected day to the one
          before it. */}
      <div className="grid grid-cols-3 gap-2">
        <StatTile
          label={isToday ? 'ยอดขายวันนี้' : 'ยอดขาย'}
          value={todayTotals.revenue}
          delta={percentChange(todayTotals.revenue, prevTotals.revenue)}
          tone="bg-admin-income-soft text-admin-income-ink"
          Icon={TrendingUp}
        />
        <StatTile
          label={isToday ? 'รายจ่ายวันนี้' : 'รายจ่าย'}
          value={todayTotals.expense}
          delta={percentChange(todayTotals.expense, prevTotals.expense)}
          tone="bg-admin-expense-soft text-admin-expense-ink"
          Icon={Wallet}
        />
        <StatTile
          label={isToday ? 'กำไรวันนี้' : 'กำไร'}
          value={todayTotals.profit}
          delta={percentChange(todayTotals.profit, prevTotals.profit)}
          tone="bg-blue-100 text-blue-800"
          Icon={Coins}
        />
      </div>

      {/* TAKINGS BY MONEY TYPE — where the selected day's money physically landed */}
      <div className="grid grid-cols-3 gap-2">
        <TakingsTile
          label="เงินสด"
          value={takings.cash}
          tone="bg-emerald-100 text-emerald-800"
          Icon={Banknote}
        />
        <TakingsTile
          label="บัญชีร้าน"
          value={takings.qr}
          tone="bg-indigo-100 text-indigo-800"
          Icon={Landmark}
        />
        <TakingsTile
          label="เป๋าตัง"
          value={takings.split}
          tone="bg-rose-100 text-rose-800"
          Icon={Smartphone}
        />
      </div>

      {/* MONTH SUMMARY — day vs night side by side for the chosen month, with a
          combined row underneath. Moved here from the สรุปยอด tab so it reads
          right below today's cards; the month is picked with the dropdown. */}
      <div className="bg-admin-card border rounded-2xl overflow-hidden shadow-xs">
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-neutral-50 border-b">
          <span className="text-[11px] font-extrabold text-neutral-700 font-kanit">สรุปยอดรายเดือน</span>
          {summaryMonths.length > 0 ? (
            <select
              value={monthKey}
              onChange={(e) => setSummaryMonth(e.target.value)}
              className="text-[10px] font-bold text-neutral-600 bg-admin-field border rounded-lg py-1 pl-2 pr-1 focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              {summaryMonths.map((m) => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          ) : (
            <span className="text-[10px] font-bold text-neutral-500">{monthLabel(monthKey)}</span>
          )}
        </div>
        <div className="grid grid-cols-[1.1fr_1fr_1fr_1fr] gap-1.5 px-3 py-2 bg-neutral-50 border-b text-[9.5px] font-extrabold text-neutral-500 font-kanit">
          <span>กะ</span>
          <span className="text-right">รายรับ</span>
          <span className="text-right">รายจ่าย</span>
          <span className="text-right">กำไรสุทธิ</span>
        </div>
        {[
          { label: 'กลางวัน', t: monthByShift.day },
          { label: 'กลางคืน', t: monthByShift.night }
        ].map(({ label, t }) => (
          <div
            key={label}
            className="grid grid-cols-[1.1fr_1fr_1fr_1fr] gap-1.5 px-3 py-2.5 border-b border-neutral-100 text-[11px] items-center font-thai"
          >
            <span className="font-bold text-neutral-800">{label}</span>
            <span className="text-right font-mono font-bold text-admin-income">{baht(t.income)}</span>
            <span className="text-right font-mono font-bold text-admin-expense">{baht(t.expense)}</span>
            <span className="text-right font-mono font-extrabold text-neutral-800">{baht(t.profit)}</span>
          </div>
        ))}
        <div className="grid grid-cols-[1.1fr_1fr_1fr_1fr] gap-1.5 px-3 py-2.5 bg-neutral-50 text-[11px] items-center font-thai">
          <span className="font-extrabold text-neutral-800 font-kanit">รวมทั้งเดือน</span>
          <span className="text-right font-mono font-extrabold text-admin-income">{baht(monthTotals.income)}</span>
          <span className="text-right font-mono font-extrabold text-admin-expense">{baht(monthTotals.expense)}</span>
          <span className="text-right font-mono font-extrabold text-neutral-800">{baht(monthTotals.profit)}</span>
        </div>
      </div>

      {/* TREND CHART */}
      <div className="bg-admin-card border rounded-2xl p-3 shadow-xs space-y-2">
        <div className="flex gap-1.5 bg-neutral-100 rounded-xl p-1 text-[11px] font-bold">
          {RANGES.map(r => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`flex-1 py-1.5 rounded-lg transition ${r.id === range ? 'bg-admin-field text-neutral-800 shadow-xs' : 'text-neutral-500'}`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* legend — top-left above the plot, the way a combo chart is usually
            keyed. Identity is never carried by colour alone: each key is a
            different SHAPE (bar swatch vs line key) as well as a different hue,
            and the two profit keys are told apart by direction as much as by
            colour. */}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pl-0.5 text-[10px] font-bold text-neutral-600">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-t-[2px]" style={{ background: C_PROFIT }} />
            กำไร
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-b-[2px]" style={{ background: C_LOSS }} />
            ขาดทุน
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-[2.5px] rounded-full" style={{ background: C_REVENUE }} />
            ยอดขาย
          </span>
        </div>

        <TrendChart points={points} range={range} />
      </div>

      {/* MENU STATS — shared with the ผู้จัดการคลัง's ดูยอดขาย tab */}
      <MenuStatsCard
        orders={orders}
        expenses={expenses}
        menu={menu}
        shift={shift}
        menuPresets={menuPresets}
        setMenuPresets={setMenuPresets}
        showToast={showToast}
      />
    </div>
  );
}

export default OwnerDashboard;
