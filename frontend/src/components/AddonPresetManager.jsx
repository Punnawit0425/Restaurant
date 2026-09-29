import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Search, X, Pencil, Check, ChevronLeft, Layers } from 'lucide-react';
import { SHIFT_LABELS } from '../menu-search';

// ---------------------------------------------------------------------------
// Owner > จัดการเมนู > แก้ไขเมนูเสริม
// ---------------------------------------------------------------------------
// Where ตัวเลือกเสริม are actually authored. A preset is one named set of
// extras — ไข่ดาว/ไข่เจียว, ท็อปปิ้ง, ระดับความหวาน — plus the dishes it is
// attached to:
//
//   { id, name, mode: 'single' | 'multi', options: [{ id, name, price }],
//     menuIds: [dish id, ...] }
//
// Two screens in one panel: the LIST of presets, and the EDITOR for one of
// them. The editor is where the linking happens, and it shows the attached
// dishes as a list you can read at a glance — the whole point of the preset is
// that you can see, in one place, exactly which dishes it changes.
//
// Nothing here writes the menu. Presets are their own resource (state
// .addonPresets) precisely because the menu is owned by PostgreSQL and re-synced
// every 30 seconds; see backend/addon-presets.js.
// ---------------------------------------------------------------------------

const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const emptyPreset = () => ({
  id: newId('preset'),
  name: '',
  nameEn: '',
  mode: 'multi',
  options: [{ id: newId('opt'), name: '', nameEn: '', price: 0 }],
  menuIds: [],
  source: 'owner',
});

const MODES = [
  {
    id: 'multi',
    label: 'เลือกได้หลายรายการ',
    hint: 'ติ๊กกี่อันก็ได้ เช่น ไข่ดาว + ไข่เจียว + ท็อปปิ้ง',
  },
  {
    id: 'single',
    label: 'เลือกได้เพียงตัวเลือกเดียว',
    hint: 'ต้องเลือก 1 อย่างเสมอ เช่น ระดับความหวาน, ขนาดแก้ว',
  },
];

function AddonPresetManager({ presets, menu, onSave, onClose, showToast }) {
  // null = the list; an object = that preset open in the editor. The editor
  // works on a DRAFT copy so ยกเลิก really does discard, and a half-typed
  // option never reaches the other tabs.
  const [draft, setDraft] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [linkSearch, setLinkSearch] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const list = Array.isArray(presets) ? presets : [];
  const menuById = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);

  // Dish label for the link list and the "ใช้อยู่กับเมนู" summary. Day and
  // night share dish names at different prices, so the shift and the price are
  // part of the identity, not decoration.
  const dishLabel = (id) => {
    const m = menuById.get(id);
    if (!m) return null;
    return {
      name: m.name,
      price: m.price,
      category: m.category,
      shift: SHIFT_LABELS[m.theme] || SHIFT_LABELS.both,
    };
  };

  const openNew = () => {
    setDraft(emptyPreset());
    setIsNew(true);
    setLinkSearch('');
  };

  const openEdit = (preset) => {
    // Deep-copied so editing options in place cannot mutate the live array.
    setDraft({
      ...preset,
      options: (preset.options || []).map((o) => ({ ...o })),
      menuIds: [...(preset.menuIds || [])],
    });
    setIsNew(false);
    setLinkSearch('');
  };

  const saveDraft = () => {
    const name = draft.name.trim();
    if (!name) return showToast('ตั้งชื่อชุดตัวเลือกเสริมก่อน');
    const options = draft.options
      .map((o) => ({ ...o, name: o.name.trim(), price: Number(o.price) || 0 }))
      .filter((o) => o.name);
    if (!options.length) return showToast('ใส่ตัวเลือกอย่างน้อย 1 รายการ');
    // A pick-one group with a single option is a radio button that cannot be
    // changed — the dish would show a control nobody can answer differently.
    if (draft.mode === 'single' && options.length < 2) {
      return showToast('แบบเลือกได้ตัวเดียวต้องมีอย่างน้อย 2 ตัวเลือก');
    }

    const clean = { ...draft, name, options };
    onSave(isNew ? [...list, clean] : list.map((p) => (p.id === clean.id ? clean : p)));
    showToast(isNew ? `สร้างชุด [${name}] แล้ว` : `บันทึกชุด [${name}] แล้ว`);
    setDraft(null);
  };

  const deletePreset = (preset) => {
    onSave(list.filter((p) => p.id !== preset.id));
    setConfirmDeleteId(null);
    showToast(`ลบชุด [${preset.name}] แล้ว`);
  };

  // --- draft editing -------------------------------------------------------
  const patch = (fields) => setDraft((d) => ({ ...d, ...fields }));
  const patchOption = (idx, fields) =>
    setDraft((d) => ({
      ...d,
      options: d.options.map((o, i) => (i === idx ? { ...o, ...fields } : o)),
    }));
  const addOption = () =>
    setDraft((d) => ({
      ...d,
      options: [...d.options, { id: newId('opt'), name: '', nameEn: '', price: 0 }],
    }));
  const removeOption = (idx) =>
    setDraft((d) => ({ ...d, options: d.options.filter((_, i) => i !== idx) }));
  const toggleLink = (dishId) =>
    setDraft((d) => ({
      ...d,
      menuIds: d.menuIds.includes(dishId)
        ? d.menuIds.filter((id) => id !== dishId)
        : [...d.menuIds, dishId],
    }));

  // The dish picker. Searching filters; the dishes already linked are pinned to
  // the top of the unsearched list so "what is this attached to" is answerable
  // without scrolling 200 rows.
  const linkCandidates = useMemo(() => {
    if (!draft) return [];
    const q = linkSearch.trim().toLowerCase();
    const rows = q
      ? menu.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            (m.nameEn || '').toLowerCase().includes(q) ||
            (m.category || '').toLowerCase().includes(q)
        )
      : menu;
    if (q) return rows;
    const linked = new Set(draft.menuIds);
    return [...rows.filter((m) => linked.has(m.id)), ...rows.filter((m) => !linked.has(m.id))];
  }, [draft, menu, linkSearch]);

  // Attach or detach every dish currently listed in the picker at once — the
  // difference between linking ยำ 21 times and linking it once.
  const bulkLink = (on) => {
    const ids = linkCandidates.map((m) => m.id);
    setDraft((d) => ({
      ...d,
      menuIds: on
        ? [...new Set([...d.menuIds, ...ids])]
        : d.menuIds.filter((id) => !ids.includes(id)),
    }));
  };

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
              {draft ? (isNew ? 'สร้างชุดตัวเลือกเสริม' : 'แก้ไขชุดตัวเลือกเสริม') : 'แก้ไขเมนูเสริม'}
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
              ชุดตัวเลือกเสริมคือกลุ่มของเพิ่มเติมที่สร้างครั้งเดียวแล้วเอาไปผูกกับเมนูไหนก็ได้ —
              เมนูที่ถูกผูกจะแสดงตัวเลือกชุดนี้ตอนสั่ง ทั้งฝั่งลูกค้าและฝั่งพนักงาน
            </p>

            <button
              onClick={openNew}
              className="w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-neutral-300 hover:border-amber-500 hover:bg-amber-500/10 text-neutral-600 hover:text-amber-700 font-bold py-2.5 rounded-xl transition"
            >
              <Plus className="w-4 h-4" />
              สร้างชุดตัวเลือกเสริมใหม่
            </button>

            {list.length === 0 ? (
              <p className="py-8 text-center text-neutral-400">ยังไม่มีชุดตัวเลือกเสริม</p>
            ) : (
              list.map((preset) => {
                const linked = (preset.menuIds || []).filter((id) => menuById.has(id));
                return (
                  <div
                    key={preset.id}
                    className="bg-admin-card border rounded-2xl p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-extrabold text-neutral-800 font-kanit text-sm">
                            {preset.name}
                          </span>
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              preset.mode === 'single'
                                ? 'bg-violet-100 text-violet-700'
                                : 'bg-emerald-100 text-emerald-700'
                            }`}
                          >
                            {preset.mode === 'single' ? 'เลือก 1 อย่าง' : 'เลือกหลายอย่าง'}
                          </span>
                        </div>
                        <p className="text-[10px] text-neutral-500 mt-0.5">
                          {(preset.options || []).map((o) => o.name).join(' · ') || '— ไม่มีตัวเลือก'}
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

                    <div className="flex items-center gap-1.5 text-[10px] text-neutral-500 border-t border-neutral-100 pt-2">
                      <Layers className="w-3 h-3" />
                      ใช้อยู่กับ <b className="text-neutral-700">{linked.length}</b> เมนู
                    </div>

                    {confirmDeleteId === preset.id && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-2.5 space-y-2">
                        <p className="text-[10px] text-red-700 font-bold">
                          ลบชุดนี้? เมนู {linked.length} รายการจะไม่แสดงตัวเลือกชุดนี้อีก
                          (ตัวเมนูและบิลเก่าไม่ถูกแตะต้อง)
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
                );
              })
            )}
          </div>
        ) : (
          /* ---------------- EDITOR ---------------- */
          <div className="space-y-3">
            {/* NAME */}
            <div>
              <label className="block font-bold text-neutral-500 mb-1">ชื่อชุดตัวเลือกเสริม</label>
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="เช่น ระดับความหวาน, ท็อปปิ้ง, ตัวเลือกเสริม"
                className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
              />
            </div>

            {/* MODE */}
            <div>
              <label className="block font-bold text-neutral-500 mb-1">รูปแบบการเลือก</label>
              <div className="space-y-1.5">
                {MODES.map((m) => (
                  <label
                    key={m.id}
                    className={`flex items-start gap-2 p-2.5 border rounded-xl cursor-pointer transition ${
                      draft.mode === m.id
                        ? 'border-amber-500 ring-1 ring-amber-500 bg-amber-500/5'
                        : 'border-neutral-200 hover:bg-neutral-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="preset-mode"
                      checked={draft.mode === m.id}
                      onChange={() => patch({ mode: m.id })}
                      className="w-4 h-4 mt-0.5 text-amber-600 focus:ring-amber-500"
                    />
                    <span className="min-w-0">
                      <span className="font-bold text-neutral-700 block">{m.label}</span>
                      <span className="text-[10px] text-neutral-400">{m.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* OPTIONS */}
            <div>
              <label className="block font-bold text-neutral-500 mb-1">
                ตัวเลือกในชุดนี้ (ราคาคือส่วนที่บวกเพิ่มจากราคาเมนู)
              </label>
              <div className="space-y-1.5">
                {draft.options.map((opt, idx) => (
                  <div key={opt.id} className="flex gap-1.5 items-center">
                    <input
                      value={opt.name}
                      onChange={(e) => patchOption(idx, { name: e.target.value })}
                      placeholder={draft.mode === 'single' ? 'เช่น 50%' : 'เช่น ไข่ดาว'}
                      className="flex-1 min-w-0 border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
                    />
                    <div className="relative w-24 flex-shrink-0">
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400 font-mono text-[11px]">
                        +฿
                      </span>
                      <input
                        type="number"
                        min="0"
                        value={opt.price}
                        onChange={(e) => patchOption(idx, { price: e.target.value })}
                        className="w-full border rounded-xl p-2.5 pl-7 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono font-bold"
                      />
                    </div>
                    <button
                      onClick={() => removeOption(idx)}
                      disabled={draft.options.length === 1}
                      className="p-2 rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-30 flex-shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addOption}
                className="mt-1.5 w-full flex items-center justify-center gap-1.5 border-2 border-dashed border-neutral-300 hover:border-amber-500 text-neutral-500 hover:text-amber-700 font-bold py-2 rounded-xl transition"
              >
                <Plus className="w-3.5 h-3.5" />
                เพิ่มตัวเลือก
              </button>
            </div>

            {/* LINKED MENUS */}
            <div className="border-t border-neutral-200 pt-3">
              <div className="flex items-baseline justify-between mb-1">
                <label className="font-bold text-neutral-500">ผูกกับเมนู</label>
                <span className="text-[10px] text-neutral-400">
                  เลือกแล้ว <b className="text-amber-600">{draft.menuIds.length}</b> เมนู
                </span>
              </div>

              {/* The dishes already attached, spelled out. This is the answer to
                  "เมนูไหนใช้ชุดนี้อยู่" and it stays visible while you search. */}
              {draft.menuIds.length > 0 && (
                <div className="mb-2 bg-amber-500/5 border border-amber-200 rounded-xl p-2 max-h-24 overflow-y-auto">
                  <div className="flex flex-wrap gap-1">
                    {draft.menuIds.map((id) => {
                      const d = dishLabel(id);
                      return (
                        <button
                          key={id}
                          onClick={() => toggleLink(id)}
                          title={d ? `${d.shift} · ${d.category}` : 'เมนูนี้ถูกลบไปแล้ว'}
                          className="flex items-center gap-1 bg-white border border-amber-300 text-amber-800 rounded-lg px-1.5 py-0.5 text-[10px] font-bold hover:bg-red-50 hover:border-red-300 hover:text-red-600"
                        >
                          {d ? `${d.name} ฿${d.price}` : '(เมนูที่ถูกลบแล้ว)'}
                          <X className="w-2.5 h-2.5" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  value={linkSearch}
                  onChange={(e) => setLinkSearch(e.target.value)}
                  placeholder="ค้นหาเมนูที่จะผูก..."
                  className="w-full border rounded-xl p-2.5 pl-8 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-bold"
                />
              </div>

              <div className="flex gap-1.5 mt-1.5">
                <button
                  onClick={() => bulkLink(true)}
                  className="flex-1 text-[10px] font-bold py-1.5 rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
                >
                  เลือกทั้งหมดที่เห็น ({linkCandidates.length})
                </button>
                <button
                  onClick={() => bulkLink(false)}
                  className="flex-1 text-[10px] font-bold py-1.5 rounded-lg border border-neutral-200 text-neutral-600 hover:bg-neutral-100"
                >
                  เอาออกทั้งหมดที่เห็น
                </button>
              </div>

              <div className="mt-1.5 border rounded-xl divide-y divide-neutral-100 max-h-64 overflow-y-auto">
                {linkCandidates.length === 0 ? (
                  <p className="py-6 text-center text-neutral-400">ไม่พบเมนู</p>
                ) : (
                  linkCandidates.map((m) => {
                    const on = draft.menuIds.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        onClick={() => toggleLink(m.id)}
                        className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left transition ${
                          on ? 'bg-amber-500/10' : 'hover:bg-neutral-50'
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="font-bold text-neutral-700 block truncate">{m.name}</span>
                          <span className="text-[10px] text-neutral-400">
                            ฿{m.price} · {SHIFT_LABELS[m.theme] || SHIFT_LABELS.both} · {m.category}
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
                {isNew ? 'สร้างชุดนี้' : 'บันทึกการแก้ไข'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AddonPresetManager;
