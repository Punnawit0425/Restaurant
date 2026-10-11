import React, { useState, useEffect, useMemo } from 'react';
import { fetchStockItems, adjustStockItem, deleteStockItem, resolveImageUrl } from '../api';
import { STOCK_ACTION_LABELS, STOCK_ACTION_COLORS, STOCK_HISTORY_DAY_LIMIT, fmtStockTime, useStockHistory } from '../stock-history';
import { workdayKey } from '../shift';
import StockHistoryDateBar from './StockHistoryDateBar';
import {
  Plus,
  Minus,
  AlertTriangle,
  X,
  Clock,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';

// คลังวัตถุดิบ (SQL stock_items) — the shared inventory panel used by both the
// staff view and the owner view. It owns its own data + popups so either screen
// can drop it in with just a <StockPanel showToast={...} />. `showToast` shows a
// brief message after each add/remove.
export default function StockPanel({ menu = [], showToast = () => {} }) {
  // The inventory rows, read from the SQL `stock_items` table.
  const [stockItems, setStockItems] = useState([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState('');
  const [stockSearch, setStockSearch] = useState('');

  // ประวัติการบันทึกสต็อก panel (audit trail).
  const [showStockHistory, setShowStockHistory] = useState(false);
  const {
    items: stockHistory, loading: historyLoading, error: historyError,
    date: historyDate, setDate: setHistoryDate, reload: reloadStockHistory,
  } = useStockHistory();

  // Load the inventory from the database on mount.
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
    loadStockItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Add `amount` to one item, persisting to the database. Updates the row in
  // place from the server's returned quantity (kept accurate even if two people
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

  // A คลัง row nobody sells any more. The dish↔stock link is by NAME (see
  // consumeStockByName), so a row goes orphaned two ways: the dish was deleted
  // back when deleting one left its stock row behind, or the dish was renamed
  // and the old row was stranded. Either way the units sitting in it are never
  // deducted again, so the row has to be visible as broken rather than just
  // sitting in the list looking normal.
  //
  // Matched with the database's own rule — LOWER(TRIM(name)).
  const key = (v) => String(v || '').trim().toLowerCase();
  const menuNames = useMemo(() => new Set((menu || []).map((m) => key(m.name))), [menu]);
  // Only judged once the menu has actually arrived: an empty menu prop (still
  // loading) would paint every single row as orphaned.
  const isOrphan = (item) => menuNames.size > 0 && !menuNames.has(key(item.name));

  // Which row is asking "ลบจริงไหม". Holds the item, or null.
  const [deleteTarget, setDeleteTarget] = useState(null);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const item = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteStockItem(item.id);
      setStockItems((prev) => prev.filter((it) => it.id !== item.id));
      showToast(`ลบ ${item.name} ออกจากคลังแล้ว`);
    } catch (err) {
      showToast(err.message || 'ลบรายการในคลังไม่สำเร็จ');
    }
  };

  // Open the ประวัติ panel on the working day in progress; the date bar inside
  // it steps back through earlier days.
  const openStockHistory = () => {
    setShowStockHistory(true);
    setHistoryDate(workdayKey());
  };

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
  // Counted across the WHOLE inventory, not just what the search shows — the
  // banner is about the state of the คลัง, not of the current filter.
  const orphanCount = stockItems.filter(isOrphan).length;

  return (
    <>
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

        {/* Orphan summary. Says the number out loud, because a row that no
            longer matches any dish quietly stops being deducted — that is a
            count drifting away from reality, not a cosmetic leftover. */}
        {orphanCount > 0 && (
          <div className="p-3 bg-orange-50 border border-orange-200 text-orange-800 rounded-2xl text-[11px] font-thai leading-relaxed">
            <b>{orphanCount} รายการในคลังไม่ตรงกับเมนูไหนเลย</b> — อาจเป็นเมนูที่ลบไปแล้ว
            หรือเมนูที่เปลี่ยนชื่อ (การตัดสต็อกจับคู่ด้วยชื่อ) รายการพวกนี้จะไม่ถูกตัดสต็อกตอนเสิร์ฟ
            กดปุ่มถังขยะที่แถวนั้นเพื่อลบออก
          </div>
        )}

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
              const orphan = isOrphan(item);
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
                      <span className="flex items-center gap-1 flex-wrap">
                        {(isOut || isLow) && (
                          <span className={`inline-flex items-center gap-1 mt-0.5 text-[9px] px-2 py-0.5 rounded-full font-bold ${isOut ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-800'}`}>
                            <AlertTriangle className="w-3 h-3" />
                            <span>{isOut ? 'หมดแล้ว' : 'ใกล้หมด'}</span>
                          </span>
                        )}
                        {orphan && (
                          <span className="inline-flex items-center gap-1 mt-0.5 text-[9px] px-2 py-0.5 rounded-full font-bold bg-orange-100 text-orange-800">
                            <AlertTriangle className="w-3 h-3" />
                            <span>ไม่มีในเมนูแล้ว</span>
                          </span>
                        )}
                      </span>
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
                      {/* Only offered on an orphan. A row that still backs a
                          dish is managed with the +/- controls; deleting it
                          would break that dish's stock deduction. */}
                      {orphan && (
                        <button
                          onClick={() => setDeleteTarget(item)}
                          className="w-8 h-8 flex items-center justify-center border border-red-300 text-red-600 hover:bg-red-500/10 font-bold rounded-lg transition"
                          title="ลบรายการนี้ออกจากคลัง"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* DELETE CONFIRM — clearing an orphaned row out of the คลัง */}
      {deleteTarget && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-xs z-[130] flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-admin-card rounded-t-3xl sm:rounded-3xl max-w-sm w-full p-5 space-y-3 text-xs font-thai shadow-2xl"
          >
            <h3 className="font-extrabold text-sm font-kanit text-neutral-800">
              ลบ [{deleteTarget.name}] ออกจากคลัง?
            </h3>
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              คงเหลือ <b className="font-mono">{deleteTarget.quantity}</b> หน่วยจะหายไปด้วยและกู้คืนไม่ได้
              — จะถูกบันทึกไว้ในประวัติการบันทึกสต็อก
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="py-2.5 rounded-xl border font-bold text-neutral-600 hover:bg-neutral-50 transition"
              >
                ไม่ลบ
              </button>
              <button
                onClick={confirmDelete}
                className="py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold transition"
              >
                ยืนยันลบ
              </button>
            </div>
          </div>
        </div>
      )}

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
    </>
  );
}
