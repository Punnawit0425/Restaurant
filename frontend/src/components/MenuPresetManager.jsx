import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Search, X, Pencil, Check, ChevronLeft, Layers } from 'lucide-react';
import { isDrinkItem } from '../menu-groups';
import { searchMenu, SHIFT_LABELS } from '../menu-search';

// ---------------------------------------------------------------------------
// Owner > แดชบอร์ด > สถิติเมนู > แก้ไข preset
// ---------------------------------------------------------------------------
// A menu preset is one named group of dishes the owner wants to read together
// in the stats table — ของทอด, เมนูแนะนำ, เมนูที่กำลังจะเลิกขาย:
//
//   { id, name, menuIds: [dish id, ...] }
//
// That is the whole shape. It changes NOTHING about how a dish is cooked,
// priced or ordered; it only decides which rows สถิติเมนู lists. Which is why
// it is its own resource (state.menuPresets) and not a field on the menu — the
// menu is owned by PostgreSQL and re-synced every 30 seconds.
//
// Two screens in one panel, the same shape as แก้ไขเมนูเสริม: the LIST of
// presets, and the EDITOR for one of them.
//
// THE PICKER LISTS DISH NAMES, NOT MENU ROWS. The same dish exists twice in the
// menu — once per shop, at two prices, under two ids — and the stats table adds
// those together into one row by name. So ticking ผัดกะเพรา has to mean every
// ผัดกะเพรา, or the table would show sales the preset says it excluded. One row
// per name here; every id behind that name goes into menuIds.
// ---------------------------------------------------------------------------

const newId = () =>
  `mpreset_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const emptyPreset = () => ({ id: newId(), name: '', menuIds: [] });

// The ประเภท filter over the picker. Food and drink are the same split the
// stats table's own ทั้งหมด / อาหาร / น้ำ tabs use (menu-groups.isDrinkItem).
const TYPES = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'food', label: 'อาหาร' },
  { id: 'drink', label: 'เครื่องดื่ม' },
];

function MenuPresetManager({ presets, menu, onSave, onClose, showToast }) {
  // null = the list; an object = that preset open in the editor. The editor
  // works on a DRAFT copy, so ยกเลิก really does discard.
  const [draft, setDraft] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const list = Array.isArray(presets) ? presets : [];

  // One row per dish NAME, carrying every menu id that name is sold under. See
  // the note at the top of this file for why the picker is shaped this way.
  const dishes = useMemo(() => {
    const byName = new Map();
    (menu || []).forEach((m) => {
      if (!m?.name) return;
      const row = byName.get(m.name) || {
        name: m.name,
        nameEn: m.nameEn || '',
        category: m.category || '',
        group: isDrinkItem(m) ? 'drink' : 'food',
        ids: [],
        prices: [],
        shifts: new Set(),
      };
      row.ids.push(m.id);
      if (!row.prices.includes(m.price)) row.prices.push(m.price);
      row.shifts.add(m.theme || 'both');
      byName.set(m.name, row);
    });
    return [...byName.values()];
  }, [menu]);

  // What the picker is showing right now: the ประเภท filter first (it is the
  // cheap one), then the search — searchMenu ranks by relevance, so its order
  // is kept rather than re-sorted.
  const visible = useMemo(() => {
    const byType = type === 'all' ? dishes : dishes.filter((d) => d.group === type);
    const q = search.trim();
    return q ? searchMenu(byType, q) : byType;
  }, [dishes, type, search]);

  // A name counts as ticked when ANY of its ids is in the preset — which is the
  // only state the toggle below can produce, and keeps presets saved before a
  // dish gained its second shop readable.
  const picked = useMemo(() => new Set(draft?.menuIds || []), [draft]);
  const isOn = (dish) => dish.ids.some((id) => picked.has(id));

  const toggleDish = (dish) => {
    const on = isOn(dish);
    setDraft((d) => ({
      ...d,
      menuIds: on
        ? d.menuIds.filter((id) => !dish.ids.includes(id))
        : [...new Set([...d.menuIds, ...dish.ids])],
    }));
  };

  // Tick or untick everything the filters are currently showing — the point of
  // having a ประเภท filter at all: อาหาร → เลือกทั้งหมดที่เห็น is two taps.
  const bulkPick = (on) => {
    const ids = visible.flatMap((d) => d.ids);
    setDraft((d) => ({
      ...d,
      menuIds: on
        ? [...new Set([...d.menuIds, ...ids])]
        : d.menuIds.filter((id) => !ids.includes(id)),
    }));
  };

  const openNew = () => {
    setDraft(emptyPreset());
    setIsNew(true);
    setSearch('');
    setType('all');
  };

  const openEdit = (preset) => {
    setDraft({ ...preset, menuIds: [...(preset.menuIds || [])] });
    setIsNew(false);
    setSearch('');
    setType('all');
  };

  const saveDraft = () => {
    const name = draft.name.trim();
    if (!name) return showToast('ตั้งชื่อ preset ก่อน');
    if (!draft.menuIds.length) return showToast('เลือกเมนูอย่างน้อย 1 รายการ');

    const clean = { ...draft, name };
    onSave(isNew ? [...list, clean] : list.map((p) => (p.id === clean.id ? clean : p)));
    showToast(isNew ? `สร้าง preset [${name}] แล้ว` : `บันทึก preset [${name}] แล้ว`);
    setDraft(null);
  };

  const deletePreset = (preset) => {
    onSave(list.filter((p) => p.id !== preset.id));
    setConfirmDeleteId(null);
    showToast(`ลบ preset [${preset.name}] แล้ว`);
  };

  // How many dishes a saved preset still points at — ids whose dish has since
  // been deleted are not counted, so the number matches what the table shows.
  const liveNames = useMemo(() => {
    const byId = new Map((menu || []).map((m) => [m.id, m.name]));
    return (ids) => new Set((ids || []).map((id) => byId.get(id)).filter(Boolean)).size;
  }, [menu]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-admin-panel w-full max-w-lg rounded-t-3xl sm:rounded-3xl p-4 space-y-3 text-xs font-thai max-h-[92vh] overflow-y-auto shadow-2xl"
      >
        {/* HEADER */}
        <div className="flex justify-between items-center gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {draft && (
              <button
                onClick={() => setDraft(null)}
                className="p-1 rounded-lg hover:bg-neutral-200 text-neutral-500 flex-shrink-0"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <h3 className="font-extrabold text-base font-kanit text-neutral-800 truncate">
              {draft ? (isNew ? 'สร้าง preset ใหม่' : 'แก้ไข preset') : 'แก้ไข preset'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-neutral-100 hover:bg-neutral-200 text-neutral-500 transition flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!draft ? (
          /* ---------------- LIST ---------------- */
          <div className="space-y-2.5">
            <p className="text-[10px] text-neutral-500 bg-neutral-100 border border-neutral-200 rounded-lg px-2.5 py-2 leading-relaxed">
              preset คือกลุ่มเมนูที่ตั้งไว้ล่วงหน้า เลือกครั้งเดียวแล้วกดดูสถิติของกลุ่มนั้นได้ตลอด —
              ใช้กับตารางสถิติเมนูเท่านั้น ไม่กระทบตัวเมนูหรือบิล
            </p>

            <button
              onClick={openNew}
              className="w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-neutral-300 hover:border-amber-500 hover:bg-amber-500/10 text-neutral-600 hover:text-amber-700 font-bold py-2.5 rounded-xl transition"
            >
              <Plus className="w-4 h-4" />
              สร้าง preset ใหม่
            </button>

            {list.length === 0 ? (
              <p className="py-8 text-center text-neutral-400">ยังไม่มี preset</p>
            ) : (
              list.map((preset) => (
                <div key={preset.id} className="bg-admin-card border rounded-2xl p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-extrabold text-neutral-800 font-kanit text-sm block truncate">
                        {preset.name}
                      </span>
                      <p className="text-[10px] text-neutral-500 mt-0.5 flex items-center gap-1">
                        <Layers className="w-3 h-3 flex-shrink-0" />
                        <b className="text-neutral-700">{liveNames(preset.menuIds)}</b> เมนูในกลุ่มนี้
                      </p>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button
                        onClick={() => openEdit(preset)}
                        className="p-1.5 rounded-lg bg-neutral-100 hover:bg-neutral-200 text-neutral-600"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(preset.id)}
                        className="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-500"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {confirmDeleteId === preset.id && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-2.5 space-y-2">
                      <p className="text-[10px] text-red-700 font-bold">
                        ลบ preset นี้? เป็นการลบแค่กลุ่ม — ตัวเมนูและยอดขายไม่ถูกแตะต้อง
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => deletePreset(preset)}
                          className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded-lg"
                        >
                          ยืนยันลบ
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="flex-1 bg-neutral-200 hover:bg-neutral-300 text-neutral-700 font-bold py-2 rounded-lg"
                        >
                          ยกเลิก
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          /* ---------------- EDITOR ---------------- */
          <div className="space-y-3">
            {/* NAME */}
            <div>
              <label className="block font-bold text-neutral-500 mb-1">ตั้งชื่อ Preset</label>
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="เช่น ของทอด, เมนูแนะนำ, เมนูขายดีหน้าร้อน"
                className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
              />
            </div>

            {/* DISH PICKER */}
            <div className="border-t border-neutral-200 pt-3">
              <div className="flex items-baseline justify-between mb-1.5">
                <label className="font-bold text-neutral-500">เลือกเมนูในกลุ่มนี้</label>
                <span className="text-[10px] text-neutral-400">
                  เลือกแล้ว <b className="text-amber-600">{dishes.filter(isOn).length}</b> เมนู
                </span>
              </div>

              {/* ประเภท — narrows the list before the search does, so ticking a
                  whole side of the menu is two taps rather than fifty. */}
              <div className="flex gap-1 bg-neutral-100 rounded-xl p-1 text-[11px] font-bold mb-1.5">
                {TYPES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setType(t.id)}
                    className={`flex-1 py-1.5 rounded-lg transition ${
                      t.id === type ? 'bg-admin-field text-neutral-800 shadow-xs' : 'text-neutral-500'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="ค้นหาชื่อเมนู..."
                  className="w-full border rounded-xl p-2.5 pl-8 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
                />
              </div>

              <div className="flex gap-1.5 mt-1.5">
                <button
                  onClick={() => bulkPick(true)}
                  className="flex-1 text-[10px] font-bold py-1.5 rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
                >
                  เลือกทั้งหมดที่เห็น ({visible.length})
                </button>
                <button
                  onClick={() => bulkPick(false)}
                  className="flex-1 text-[10px] font-bold py-1.5 rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
                >
                  เอาออกทั้งหมดที่เห็น
                </button>
              </div>

              <div className="mt-1.5 border rounded-xl divide-y divide-neutral-100 max-h-72 overflow-y-auto">
                {visible.length === 0 ? (
                  <p className="py-6 text-center text-neutral-400">ไม่พบเมนู</p>
                ) : (
                  visible.map((d) => {
                    const on = isOn(d);
                    return (
                      <button
                        key={d.name}
                        onClick={() => toggleDish(d)}
                        className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left transition ${
                          on ? 'bg-amber-500/10' : 'hover:bg-neutral-50'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="font-bold text-neutral-700 block truncate">{d.name}</span>
                          <span className="text-[10px] text-neutral-400">
                            ฿{d.prices.join(' / ')} · {d.category}
                            {/* Sold in both shops = one row here, two in the
                                menu. Saying so stops it reading as a duplicate. */}
                            {d.shifts.size > 1
                              ? ' · ขายทั้ง 2 ร้าน'
                              : ` · ${SHIFT_LABELS[[...d.shifts][0]] || SHIFT_LABELS.both}`}
                          </span>
                        </span>
                        <span
                          className={`w-5 h-5 rounded-md border flex items-center justify-center flex-shrink-0 ${
                            on ? 'bg-amber-600 border-amber-600 text-white' : 'border-neutral-300'
                          }`}
                        >
                          {on && <Check className="w-3.5 h-3.5" />}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* SAVE */}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setDraft(null)}
                className="flex-1 bg-neutral-200 hover:bg-neutral-300 text-neutral-700 font-bold py-3 rounded-xl transition"
              >
                ยกเลิก
              </button>
              <button
                onClick={saveDraft}
                className="flex-[2] bg-amber-600 hover:bg-amber-700 text-white font-bold py-3 rounded-xl transition"
              >
                บันทึก
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MenuPresetManager;
