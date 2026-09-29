import React, { useMemo, useState } from 'react';
// ChefHat is the empty-board illustration only — the action buttons are text,
// so a cook reads the word, not an icon they have to decode.
import { ChefHat, Scissors, Plus, X } from 'lucide-react';
import { kitchenBoard } from '../kitchen';
import { deriveBillStatus, ITEM_STATUS_LABELS, ITEM_STATUS_COLORS, tableLabel } from '../orders';

// ---------------------------------------------------------------------------
// Kitchen board — Batch ordering
// ---------------------------------------------------------------------------
// Renders the shared `orders` as grouped batch cards (see ../kitchen.js for the
// batching rules). The board is a pure view of orders: the only things written
// back are each line's `status` and, once a cook starts a batch, a shared
// `batchId` that freezes the group. Every write goes through setOrders, so the
// order-taking tab and customer screens update over SSE at the same instant.
//
// A dish leaves the board the moment it is marked "เสร็จแล้ว" (completed);
// delivery/serving (and its stock deduction) is handled on the order board.
// ---------------------------------------------------------------------------

const CLOSED = new Set(['paid', 'cancelled']);
const newBatchId = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function KitchenBoard({ orders, setOrders, menu, showToast, shiftView }) {
  // Which card's tool tray (✂️ / ➕) is open, keyed by batch id.
  const [toolOpen, setToolOpen] = useState(null);

  const cards = useMemo(
    () => kitchenBoard(orders || [], { menu, shift: shiftView }),
    [orders, menu, shiftView]
  );

  // Lines still waiting in the kitchen (unlocked), grouped for the ➕ picker.
  const inKitchenByName = useMemo(() => {
    const map = new Map();
    cards.filter(c => c.status === 'in_kitchen').forEach(c => {
      c.members.forEach(m => {
        if (!map.has(m.name)) map.set(m.name, []);
        map.get(m.name).push(m);
      });
    });
    return map;
  }, [cards]);

  // Apply a patch to every line whose uid is in `uids`, then re-derive each
  // touched bill's status. `patch` may be an object or (item) => partial.
  const patchUids = (uids, patch) => {
    const set = uids instanceof Set ? uids : new Set(uids);
    setOrders(prev => prev.map(o => {
      if (CLOSED.has(o.status)) return o;
      let changed = false;
      const items = o.items.map(it => {
        if (!set.has(it.uid)) return it;
        changed = true;
        return { ...it, ...(typeof patch === 'function' ? patch(it) : patch) };
      });
      if (!changed) return o;
      return { ...o, items, status: deriveBillStatus(items) };
    }));
  };

  const memberUids = (batch) => batch.members.map(m => m.uid);

  // in_kitchen -> in_progress: lock the whole batch under one fresh batchId so no
  // new order can auto-join it while it cooks.
  const startBatch = (batch) => {
    patchUids(memberUids(batch), { status: 'in_progress', batchId: newBatchId() });
    showToast(`เริ่มทำ ${batch.name} · ${batch.totalQty} จาน`);
  };

  const completeBatch = (batch) => {
    patchUids(memberUids(batch), { status: 'completed' });
    showToast(`${batch.name} เสร็จแล้ว`);
  };

  // ✂️ pull one line out of a locked batch → its own solo batch (keeps cooking).
  const splitMember = (member) => {
    patchUids([member.uid], { batchId: newBatchId() });
    setToolOpen(null);
    showToast(`แยก ${member.name} (โต๊ะ ${member.table}) ออกจากกลุ่มแล้ว`);
  };

  // ➕ pull a waiting (in_kitchen) line of the same dish into this cooking batch.
  const addToBatch = (batch, member) => {
    patchUids([member.uid], { status: 'in_progress', batchId: batch.id });
    setToolOpen(null);
    showToast(`เพิ่ม ${member.name} (โต๊ะ ${member.table}) เข้ากลุ่มกำลังทำแล้ว`);
  };

  if (cards.length === 0) {
    return (
      <div className="text-center py-16 text-neutral-400">
        <ChefHat className="w-10 h-10 mx-auto mb-3 opacity-40" />
        <p className="text-sm font-bold font-thai">ยังไม่มีรายการอาหารในครัว</p>
        <p className="text-[11px] font-medium mt-1">ออเดอร์อาหารจะเข้ามาที่นี่โดยอัตโนมัติ (ไม่รวมเครื่องดื่ม)</p>
      </div>
    );
  }

  return (
    // A single tall column on a phone; two on a desktop/tablet, so a busy
    // kitchen screen shows twice as many tickets without scrolling.
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 items-start font-thai">
      {cards.map((batch) => {
        // Waiting lines of this same dish on OTHER cards. A waiting card's own
        // lines are in that map too, and must not count as a duplicate of itself.
        const own = new Set(batch.members.map((m) => m.uid));
        const candidates = (inKitchenByName.get(batch.name) || []).filter((m) => !own.has(m.uid));
        // The card shows its state ONCE, on a two-part switch: กำลังทำ | เสร็จแล้ว.
        // A dish still waiting has neither half lit (both sit in the card's own
        // colour); once started, กำลังทำ fills with its status colour; เสร็จแล้ว
        // takes the dish off the board, so that half is never seen lit. Either
        // half can be pressed from waiting — a quick dish may go straight to done.
        const cooking = batch.status === 'in_progress';
        // Each tool shows only when the dish is duplicated in a way it can act
        // on — ✂️ when this card holds it for two or more tables, ➕ when it is
        // also waiting on another card — and is live only once cooking starts,
        // since a waiting group is still being regrouped automatically.
        const showSplit = batch.members.length > 1;
        const showAdd = candidates.length > 0;

        return (
          <div
            key={batch.id}
            className={`bg-admin-card border rounded-2xl p-3 shadow-xs ${batch.isBatch ? 'border-amber-300 ring-1 ring-amber-200' : 'border-line'}`}
          >
            {/* One row: how many · what (and for whom) · what to press.
                Vertically centred so a one-table card and a four-table card
                both read as the same shape from across the kitchen. */}
            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-amber-500 text-white flex items-center justify-center flex-shrink-0">
                <span className="font-extrabold text-xl font-mono leading-none">{batch.totalQty}x</span>
              </div>

              <div className="flex-1 min-w-0">
                {/* Wraps rather than truncates: with a fixed-width button beside
                    it there is not much room on a phone, and "ผัดกระเทียม…" tells
                    a cook nothing. A second line costs a few pixels. */}
                <span className="block font-extrabold text-base text-neutral-800 leading-tight break-words">
                  {batch.name}
                </span>
                {/* Per-table breakdown. On a batch card this doubles as the
                    "how many tables" count, which is why no separate pill says
                    it. */}
                <div className="mt-0.5 space-y-0.5">
                  {batch.members.map((m) => (
                    <div key={m.uid} className="flex items-baseline gap-1.5 text-[11px] flex-wrap">
                      <span className="font-bold text-neutral-600 whitespace-nowrap">{tableLabel(m.table)}</span>
                      <span className="font-mono text-amber-600 font-bold">{m.qty}x</span>
                      {m.addOns.length > 0 && (
                        <span className="text-sm font-extrabold text-emerald-600">+{m.addOns.join(', ')}</span>
                      )}
                      {m.note && <span className="text-red-500 italic">📝 {m.note}</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Big enough to hit with a wet hand without looking straight at
                  it — this is the one control on the card. */}
              <div className="w-40 sm:w-48 flex-shrink-0 space-y-1.5">
                <div className="flex rounded-full border border-amber-500 overflow-hidden">
                  <button
                    onClick={() => startBatch(batch)}
                    disabled={cooking}
                    aria-pressed={cooking}
                    className={`flex-1 py-5 font-extrabold text-sm transition ${cooking ? ITEM_STATUS_COLORS.in_progress : 'bg-admin-card text-neutral-800 hover:bg-neutral-100'}`}
                  >
                    {ITEM_STATUS_LABELS.in_progress}
                  </button>
                  <button
                    onClick={() => completeBatch(batch)}
                    className="flex-1 py-5 font-extrabold text-sm transition border-l border-amber-500 bg-admin-card text-neutral-800 hover:bg-neutral-100"
                  >
                    {ITEM_STATUS_LABELS.completed}
                  </button>
                </div>

                {(showSplit || showAdd) && (
                <div className="flex justify-center gap-1.5">
                  {showSplit && (
                  <button
                    onClick={() => setToolOpen(toolOpen === `split-${batch.id}` ? null : `split-${batch.id}`)}
                    disabled={!cooking}
                    title={cooking ? 'แยกจานออกจากกลุ่ม' : 'กด "กำลังทำ" ก่อนจึงแยกจานได้'}
                    aria-label="แยกจานออกจากกลุ่ม"
                    className="w-16 py-1.5 border border-line rounded-xl text-neutral-500 hover:bg-neutral-100 transition flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  >
                    <Scissors className="w-4 h-4" />
                  </button>
                  )}
                  {showAdd && (
                  <button
                    onClick={() => setToolOpen(toolOpen === `add-${batch.id}` ? null : `add-${batch.id}`)}
                    disabled={!cooking}
                    title={cooking ? 'ดึงเมนูเดียวกันจากโต๊ะอื่นเข้ากลุ่ม' : 'กด "กำลังทำ" ก่อนจึงดึงเมนูเข้ากลุ่มได้'}
                    aria-label="ดึงเมนูเดียวกันจากโต๊ะอื่นเข้ากลุ่ม"
                    className="w-16 py-1.5 border border-line rounded-xl text-neutral-500 hover:bg-neutral-100 transition flex items-center justify-center disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  )}
                </div>
                )}
              </div>
            </div>

            {/* ✂️ split tray */}
            {toolOpen === `split-${batch.id}` && (
              <ToolTray title="แยกจานไหนออก?" onClose={() => setToolOpen(null)}>
                {batch.members.map((m) => (
                  <button
                    key={m.uid}
                    onClick={() => splitMember(m)}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-admin-field hover:bg-neutral-100 text-[11px] font-bold transition"
                  >
                    <span>{tableLabel(m.table)} · {m.qty} จาน</span>
                    <Scissors className="w-3.5 h-3.5 text-neutral-400" />
                  </button>
                ))}
              </ToolTray>
            )}

            {/* ➕ manual-add tray */}
            {toolOpen === `add-${batch.id}` && (
              <ToolTray title="ดึงเมนูเดียวกันเข้ากลุ่ม" onClose={() => setToolOpen(null)}>
                {candidates.map((m) => (
                  <button
                    key={m.uid}
                    onClick={() => addToBatch(batch, m)}
                    className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-admin-field hover:bg-neutral-100 text-[11px] font-bold transition"
                  >
                    <span>{tableLabel(m.table)} · คิว {m.queueNo} · {m.qty} จาน</span>
                    <Plus className="w-3.5 h-3.5 text-neutral-400" />
                  </button>
                ))}
              </ToolTray>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToolTray({ title, onClose, children }) {
  return (
    <div className="mt-2 pt-2 border-t border-neutral-100">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-extrabold text-neutral-500">{title}</span>
        <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export default KitchenBoard;
