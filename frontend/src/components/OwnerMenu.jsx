import React, { useState, useMemo, useEffect, useRef } from 'react';
// `Menu` is the three-horizontal-lines icon; renamed on import so it can never
// be misread as this screen's `menu` prop.
import { Plus, Trash2, Search, ImageUp, X, Loader2, Pencil, Sun, Moon, Menu as GripLines, ChevronUp, ChevronDown } from 'lucide-react';
import {
  fetchMenuOptions,
  uploadMenuImage,
  createMenuItem,
  fetchMenuItem,
  updateMenuItem,
  deleteMenuItem,
  fetchStockItems,
  adjustStockItem,
  setMenuTheme,
  setMenuOrder,
  resolveImageUrl,
} from '../api';
import { shrinkImage } from '../image';
import AddonPresetManager from './AddonPresetManager';

// ---------------------------------------------------------------------------
// Owner > จัดการเมนู
// ---------------------------------------------------------------------------
// Two jobs: flip a dish on/off sale, and add a new one.
//
// Neither writes to the shared `menu` state. The menu's source of truth is the
// PostgreSQL table, which the backend re-reads on a timer — anything written
// into state.menu from here would simply be overwritten on the next sync. So
// both actions call an endpoint that changes the DATABASE, and the updated menu
// comes back to every open tab over the existing SSE stream. That is also why
// there is no local copy of the list here: `menu` arrives as a prop and is
// already live.
// ---------------------------------------------------------------------------

const FORM_THEMES = [
  { id: 'day', label: 'กลางวัน' },
  { id: 'night', label: 'กลางคืน' },
  { id: 'both', label: 'ทั้งสอง' },
];

// The list no longer splits by shift — every dish is shown together and each one
// carries its own sun/moon pill. These two map between the single `theme` column
// ('day' | 'night' | 'both' | 'none') and the pair of on/off shift toggles.
function shiftsFromTheme(theme) {
  return {
    day: theme === 'day' || theme === 'both',
    night: theme === 'night' || theme === 'both',
  };
}
function themeFromShifts(day, night) {
  if (day && night) return 'both';
  if (day) return 'day';
  if (night) return 'night';
  return 'none'; // shown in no storefront
}

// Pull one entry out of a list and drop it back in at another index.
function moveItem(list, from, to) {
  if (from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const EMPTY_FORM = {
  category: '',
  type: 'เมนูหลัก',
  subcategory: '',
  subcategoryEn: '',
  name: '',
  nameEn: '',
  price: '',
  quantity: '',
  imageUrl: '',
};

// A <select> of the values already in the database, plus a "พิมพ์เอง…" escape
// hatch — the owner has to be able to create a genuinely new category without
// waiting for a code change, but picking an existing one should not require
// retyping it exactly (a typo would silently create a near-duplicate heading).
function ComboBox({ label, value, options, onChange, placeholder, required }) {
  const [typing, setTyping] = useState(false);
  const isCustom = typing || (value && !options.includes(value));

  return (
    <div>
      <label className="block font-bold text-neutral-500 mb-1">{label}</label>
      {isCustom ? (
        <div className="flex gap-1.5">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            autoFocus
            className="flex-1 border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
          />
          {options.length > 0 && (
            <button
              type="button"
              onClick={() => { setTyping(false); onChange(''); }}
              className="px-3 rounded-xl border text-neutral-500 hover:bg-neutral-50 transition"
              title="เลือกจากรายการเดิม"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ) : (
        <select
          value={value}
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              setTyping(true);
              onChange('');
            } else {
              onChange(e.target.value);
            }
          }}
          required={required}
          className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
        >
          <option value="">— เลือก —</option>
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
          <option value="__custom__">+ พิมพ์ค่าใหม่เอง…</option>
        </select>
      )}
    </div>
  );
}

// Matched the way the DATABASE matches a dish to its stock row — LOWER(TRIM),
// see consumeStockByName.
const stockKey = (v) => String(v || '').trim().toLowerCase();

// `stockOnly` is the ผู้จัดการคลัง view of this screen: only dishes that have a
// คลังวัตถุดิบ row are listed or editable, and the actions that reach the rest of
// the menu (a plain new dish, ตัวเลือกเสริม, moving a whole หัวข้อ) are gone. The
// server enforces the same scope; this is what keeps the screen honest about it.
function OwnerMenu({ menu, addonPresets, setAddonPresets, showToast, stockOnly = false }) {
  // แก้ไขเมนูเสริม — the preset manager, opened from the right half of the add
  // button. Its own panel rather than a tab: it edits a different resource
  // (state.addonPresets) and has nothing to say about the dish list behind it.
  const [showPresets, setShowPresets] = useState(false);
  const [search, setSearch] = useState('');
  const [heading, setHeading] = useState('all');
  // Dish ids with a toggle request in flight, so a double tap can't send two
  // conflicting writes.
  const [pending, setPending] = useState(() => new Set());

  const [showForm, setShowForm] = useState(false);
  // 'menu' = add a dish only. 'stock' = add the dish AND file it in คลังวัตถุดิบ.
  // Both use the exact same form; stock mode just reveals a quantity field and
  // writes an inventory row on submit.
  const [formMode, setFormMode] = useState('menu');
  // The dish id currently being edited, or null when adding a new one. When set,
  // the same form saves over an existing dish instead of creating one.
  const [editingId, setEditingId] = useState(null);
  // Dish whose editable copy is being fetched, so its pencil shows a spinner.
  const [loadingEditId, setLoadingEditId] = useState(null);
  // When the dish being edited also has a คลังวัตถุดิบ row (matched by name — the
  // drinks/stocked items), this holds { id, quantity } so the edit form can offer
  // a "จำนวนปัจจุบัน" box. null = the dish isn't in stock, so no box is shown.
  const [editStock, setEditStock] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formTheme, setFormTheme] = useState('day');
  const [variants, setVariants] = useState([]);
  // `pairs` is the (หมวดหมู่, หัวข้อ) combinations that exist in the database; the
  // three flat lists are every distinct value of each field.
  const [options, setOptions] = useState({ categories: [], types: [], subcategories: [], pairs: [] });
  const [imagePreview, setImagePreview] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Deleting is the one action here that cannot be undone, so it is two taps:
  // `confirmDelete` is the "are you sure" state of the button inside the edit
  // form, and `deleting` is the write in flight.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef(null);

  // --- Drag to reorder ------------------------------------------------------
  // The order just sent to the server, kept so the list stays where the owner
  // dropped it during the round trip instead of snapping back for a moment. Live
  // drag state (which row is held, where it would land) is separate.
  const [pendingOrder, setPendingOrder] = useState(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [drag, setDrag] = useState(null);
  // The same drag, readable synchronously: pointermove fires far faster than
  // React re-renders, and the drop handler needs the last target index, not
  // whichever one React had committed when the handler was created.
  const dragRef = useRef(null);

  // stockOnly: the LOWER(TRIM) names of every คลัง row. null until the first read
  // answers, so the list shows nothing rather than flashing the whole menu.
  const [stockNames, setStockNames] = useState(null);
  const [stockNamesError, setStockNamesError] = useState('');
  // Re-read whenever the menu changes: a dish added through เพิ่มเมนูในสต็อก (here or
  // on another device) arrives with a new คลัง row, and the คลัง itself is not on
  // the SSE stream.
  useEffect(() => {
    if (!stockOnly) return;
    let cancelled = false;
    fetchStockItems()
      .then((items) => {
        if (cancelled) return;
        setStockNames(new Set((items || []).map((s) => stockKey(s.name))));
        setStockNamesError('');
      })
      .catch((err) => { if (!cancelled) setStockNamesError(err.message || 'โหลดคลังไม่สำเร็จ'); });
    return () => { cancelled = true; };
  }, [stockOnly, menu]);

  // Dropdown values come from the database, so a heading added straight in
  // pgAdmin is offered here too. Fetched when the form opens rather than on
  // mount, so simply viewing the list costs nothing.
  //
  // showToast is deliberately not a dependency: App re-creates it on every
  // render, and every SSE push re-renders App — including it would re-fetch the
  // options on each one for as long as the form stayed open.
  useEffect(() => {
    if (!showForm) return;
    fetchMenuOptions()
      .then(setOptions)
      .catch((err) => showToast(`โหลดตัวเลือกไม่สำเร็จ: ${err.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  // --- หัวข้อ narrowed by หมวดหมู่ ------------------------------------------
  // A หัวข้อ belongs to exactly one หมวดหมู่ — "ชา" only ever sits under เครื่องดื่ม,
  // "เมนูราดข้าว" only under อาหาร. Offering the full list on every dish let a
  // drink heading be filed on a food dish, which then sorted into the wrong
  // storefront section. So once a หมวดหมู่ is picked, only its own headings are on
  // the menu. No หมวดหมู่ yet → show them all; a brand-new หมวดหมู่ has none of its
  // own yet, and the empty list is honest — "+ พิมพ์ค่าใหม่เอง…" is still there.
  const subcategoryOptions = useMemo(() => {
    const pairs = options.pairs || [];
    if (!form.category || pairs.length === 0) return options.subcategories;
    return [
      ...new Set(pairs.filter((p) => p.category === form.category).map((p) => p.subcategory)),
    ].sort((a, b) => a.localeCompare(b, 'th'));
  }, [options, form.category]);

  // Thai -> English lookups mined from the live menu. The built menu carries a
  // dish's หัวข้อ as `category`/`categoryEn` and each protein as an `options[]`
  // entry ({ name, nameEn }), so every translation the owner has ever entered is
  // already here — enough to auto-fill the EN field the moment a known หัวข้อ or
  // เนื้อสัตว์ is chosen. First non-empty translation seen for a term wins.
  const { meatOptions, meatEnByName, subcategoryEnByName } = useMemo(() => {
    const meatEn = new Map();
    const meats = new Set();
    const subEn = new Map();
    (menu || []).forEach((dish) => {
      if (dish.category && dish.categoryEn && !subEn.has(dish.category)) {
        subEn.set(dish.category, dish.categoryEn);
      }
      (dish.options || []).forEach((o) => {
        if (!o.name || o.name === '-') return;
        meats.add(o.name);
        if (o.nameEn && !meatEn.has(o.name)) meatEn.set(o.name, o.nameEn);
      });
    });
    return {
      meatOptions: [...meats].sort((a, b) => a.localeCompare(b, 'th')),
      meatEnByName: meatEn,
      subcategoryEnByName: subEn,
    };
  }, [menu]);

  // Switching หมวดหมู่ must not leave the previous category's หัวข้อ behind. Only a
  // heading the database knows is dropped: one the owner typed by hand is theirs
  // to keep, and clearing it would wipe their text keystroke by keystroke while
  // they type a new หมวดหมู่ (ComboBox reports every character).
  const handleCategoryChange = (v) => {
    setForm((f) => {
      const pairs = options.pairs || [];
      const known = pairs.some((p) => p.subcategory === f.subcategory);
      const fitsHere = pairs.some((p) => p.category === v && p.subcategory === f.subcategory);
      return { ...f, category: v, subcategory: !known || fitsHere ? f.subcategory : '' };
    });
  };

  // One combined list — day and night dishes together. Visibility per shift is
  // controlled by each row's sun/moon pill, not by a page-level shift switch.
  //
  // The menu arrives in the order the database holds it, which is the order the
  // customer sees. While a reorder is in flight the just-dropped order is laid
  // over it, so the row stays where it was dropped rather than jumping back for
  // the second it takes the write and the SSE push to come round.
  const allMenu = useMemo(() => {
    const list = menu || [];
    if (!pendingOrder) return list;
    const rank = new Map(pendingOrder.map((id, i) => [id, i]));
    // A dish the pending order never saw (added from another tab) sorts last
    // rather than to the front, which is where the server would put it too.
    return [...list].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
    );
  }, [menu, pendingOrder]);

  // Drop the optimistic order once the real menu carries it — or once the menu
  // has changed shape underneath it (a dish added or deleted elsewhere), where
  // holding on would keep sorting by a list that no longer describes the menu.
  useEffect(() => {
    if (!pendingOrder) return;
    const live = (menu || []).map((m) => m.id);
    const arrived = live.length === pendingOrder.length && live.every((id, i) => id === pendingOrder[i]);
    const wanted = new Set(pendingOrder);
    const sameDishes = live.length === pendingOrder.length && live.every((id) => wanted.has(id));
    if (arrived || !sameDishes) setPendingOrder(null);
  }, [menu, pendingOrder]);

  // The dishes this person may see. `allMenu` stays whole regardless: a reorder
  // writes the full menu back, and the dishes outside the scope have to keep
  // their slots in it (see commitMove).
  const scopedMenu = useMemo(() => {
    if (!stockOnly) return allMenu;
    if (!stockNames) return [];
    return allMenu.filter((m) => stockNames.has(stockKey(m.name)));
  }, [allMenu, stockOnly, stockNames]);

  // In APPEARANCE order (not alphabetical): this is the order the customer sees
  // the หัวข้อ sections in, and the order the ⬆⬇ buttons below rearrange — so the
  // dropdown has to mirror it for a move to be visible.
  const headings = useMemo(
    () => [...new Set(scopedMenu.map((m) => m.category).filter(Boolean))],
    [scopedMenu]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scopedMenu.filter(
      (m) =>
        (heading === 'all' || m.category === heading) &&
        (!q || m.name.toLowerCase().includes(q))
    );
  }, [scopedMenu, heading, search]);

  // "Hidden" = shown in no shift (theme 'none').
  const hiddenCount = scopedMenu.filter((m) => (m.theme || 'day') === 'none').length;

  // The list as it should look right now: mid-drag the held row is already shown
  // in the slot it would land in, so the gap opening up under the finger is the
  // preview of the result.
  const rows = drag ? moveItem(visible, drag.fromIndex, drag.toIndex) : visible;

  // --- Drag to reorder ------------------------------------------------------
  // Rows are a fixed height (a 44px thumbnail plus padding, and every label is
  // truncated to one line), so how far the finger has travelled divided by that
  // height is how many places the dish has moved. Pointer events rather than
  // HTML5 drag-and-drop: this screen is used on a phone, where dragstart never
  // fires at all.
  const handleDragStart = (e, index, dish) => {
    if (drag) return;
    const row = e.currentTarget.closest('[data-dish-row]');
    const height = row?.getBoundingClientRect().height || 64;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      height,
      fromIndex: index,
      toIndex: index,
      id: dish.id,
      count: visible.length,
      el: row, // written to directly while the finger moves — see below
    };
    setDrag({ id: dish.id, fromIndex: index, toIndex: index, dy: 0, height });
  };

  const handleDragMove = (e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = e.clientY - d.startY;
    const steps = Math.round(dy / d.height);
    const toIndex = Math.max(0, Math.min(d.count - 1, d.fromIndex + steps));

    // The held row is nudged straight on the DOM node: pointermove fires many
    // times a second, and re-rendering a 140-row list that often to move one row
    // a few pixels stutters on a phone. React state is updated only when the row
    // would actually change places — the one moment the OTHER rows have to move
    // too — and it carries the same dy, so the re-render lands the row exactly
    // where these writes had it.
    if (d.el) d.el.style.transform = `translateY(${dy - (toIndex - d.fromIndex) * d.height}px)`;
    if (toIndex !== d.toIndex) {
      d.toIndex = toIndex;
      setDrag((cur) => (cur ? { ...cur, dy, toIndex } : cur));
    }
  };

  // Clear the inline transform the move handler wrote, or the row would keep the
  // last offset once it is no longer the held row.
  const endDrag = () => {
    const d = dragRef.current;
    if (d?.el) d.el.style.transform = '';
    dragRef.current = null;
    setDrag(null);
    return d;
  };

  const handleDragCancel = () => { endDrag(); };

  // Save one move. Shared by the drop and the keyboard shortcut so both write
  // the menu the same way.
  const commitMove = async (fromIndex, toIndex) => {
    if (fromIndex === toIndex || toIndex < 0 || toIndex >= visible.length) return;

    // Only the dishes on screen were dragged, so only the slots they occupy in
    // the full menu are rewritten — the ones a filter or a search is hiding keep
    // their own places. Reordering just `visible` and concatenating the rest
    // would instead fling every hidden dish to the end of the menu.
    const reordered = moveItem(visible, fromIndex, toIndex);
    const onScreen = new Set(visible.map((m) => m.id));
    const nextIds = allMenu.map((m) => m.id);
    const slots = [];
    nextIds.forEach((id, i) => { if (onScreen.has(id)) slots.push(i); });
    reordered.forEach((dish, i) => { nextIds[slots[i]] = dish.id; });

    setPendingOrder(nextIds);
    setSavingOrder(true);
    try {
      await setMenuOrder(nextIds);
      // No local menu write: the backend renumbers the rows and pushes the new
      // menu over SSE, which is what every customer tab is reading.
    } catch (err) {
      setPendingOrder(null); // put the list back where the server still has it
      showToast(`เรียงลำดับไม่สำเร็จ: ${err.message}`);
    } finally {
      setSavingOrder(false);
    }
  };

  const handleDragEnd = () => {
    const d = endDrag();
    if (d) commitMove(d.fromIndex, d.toIndex);
  };

  // Arrow keys move the focused dish one place, so the order can be set without
  // a pointer at all — and, on a phone, without a long steady drag.
  const handleHandleKeyDown = (e, index) => {
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    commitMove(index, index + delta);
  };

  // --- Reorder whole หัวข้อ (category) sections -----------------------------
  // The customer groups dishes under their category and shows those sections in
  // the order each category first appears in the menu. So moving a หัวข้อ is
  // moving its whole block of dishes past the neighbouring block: rebuild the
  // flat id list category-by-category in the new order (dish order within each
  // block is kept), then persist it the same way a dish drag does. dir is -1 to
  // move the selected heading earlier, +1 to move it later.
  const moveHeading = async (dir) => {
    if (stockOnly || heading === 'all' || savingOrder) return;
    const order = [...new Set(allMenu.map((m) => m.category).filter(Boolean))];
    const idx = order.indexOf(heading);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];

    // Group dish ids by category, preserving each category's own dish order.
    const byCat = new Map();
    const noCat = []; // dishes with no category keep to the end, in place
    allMenu.forEach((m) => {
      if (!m.category) { noCat.push(m.id); return; }
      if (!byCat.has(m.category)) byCat.set(m.category, []);
      byCat.get(m.category).push(m.id);
    });
    const nextIds = [];
    order.forEach((cat) => (byCat.get(cat) || []).forEach((id) => nextIds.push(id)));
    noCat.forEach((id) => nextIds.push(id));

    setPendingOrder(nextIds);
    setSavingOrder(true);
    try {
      await setMenuOrder(nextIds);
    } catch (err) {
      setPendingOrder(null);
      showToast(`เรียงลำดับหัวข้อไม่สำเร็จ: ${err.message}`);
    } finally {
      setSavingOrder(false);
    }
  };

  // --- Shift visibility (sun/moon pill) -------------------------------------
  // Toggle one shift (day or night) for a dish. The other shift is left as-is,
  // and the two booleans collapse back into the single `theme` value the backend
  // stores. Turning both off hides the dish everywhere ('none').
  const handleToggleShift = async (dish, which) => {
    if (pending.has(dish.id)) return;
    const cur = shiftsFromTheme(dish.theme || 'day');
    const next = { ...cur, [which]: !cur[which] };
    const nextTheme = themeFromShifts(next.day, next.night);

    setPending((prev) => new Set(prev).add(dish.id));
    try {
      await setMenuTheme(dish.id, nextTheme);
      // No local state update: the backend re-syncs from the database and pushes
      // the new menu over SSE, which lands in every tab at once.
      const where =
        nextTheme === 'both' ? 'กลางวัน + กลางคืน'
          : nextTheme === 'day' ? 'กลางวัน'
            : nextTheme === 'night' ? 'กลางคืน'
              : null;
      showToast(
        where
          ? `[${dish.name}] แสดงช่วง ${where}`
          : `ซ่อน [${dish.name}] แล้ว (ไม่แสดงทั้งกลางวันและกลางคืน)`
      );
    } catch (err) {
      showToast(`เปลี่ยนไม่สำเร็จ: ${err.message}`);
    } finally {
      setPending((prev) => {
        const n = new Set(prev);
        n.delete(dish.id);
        return n;
      });
    }
  };

  // --- New dish form --------------------------------------------------------
  const resetForm = () => {
    setForm(EMPTY_FORM);
    setVariants([]);
    setImagePreview('');
    setEditingId(null);
    setEditStock(null);
    setConfirmDelete(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Open the form pre-filled with an existing dish. The editable copy — which
  // includes หมวดหมู่/ประเภท the app-facing menu drops — is fetched from the
  // backend rather than read off the menu prop, so what is saved back is exactly
  // what is in the database.
  const startEdit = async (dish) => {
    if (loadingEditId) return;
    setLoadingEditId(dish.id);
    try {
      // Fetch the editable dish spec and the current inventory together: a stock
      // row is linked to a dish by name (the drinks/stocked items), so we look up
      // this dish's row to offer a live "จำนวนปัจจุบัน" box. Stock is best-effort —
      // if it can't be read, the dish still edits, just without the quantity box.
      const [spec, stockItems] = await Promise.all([
        fetchMenuItem(dish.id),
        fetchStockItems().catch(() => []),
      ]);
      // Matched the way the DATABASE matches a dish to its stock row —
      // LOWER(TRIM(name)), see consumeStockByName. A plain `===` here was
      // stricter than the rule the rest of the system uses, so a คลัง row
      // imported with a stray space or a different case never linked: no
      // จำนวนปัจจุบัน box, and no photo mirrored onto it.
      const stockRow = (stockItems || []).find((s) => stockKey(s.name) === stockKey(spec.name || dish.name));
      setEditStock(stockRow ? { id: stockRow.id, quantity: stockRow.quantity, imageUrl: stockRow.imageUrl || '' } : null);
      setForm({
        category: spec.category || '',
        type: spec.type || 'เมนูหลัก',
        subcategory: spec.subcategory || '',
        subcategoryEn: spec.subcategoryEn || '',
        name: spec.name || '',
        nameEn: spec.nameEn || '',
        price: spec.price != null ? String(spec.price) : '',
        quantity: stockRow ? String(stockRow.quantity) : '',
        imageUrl: spec.imageUrl || '',
      });
      setVariants(
        (spec.variants || []).map((v) => ({
          meat: v.meat,
          meatEn: v.meatEn || '',
          price: String(v.price),
        }))
      );
      setFormTheme(spec.theme || 'day');
      setImagePreview('');
      setConfirmDelete(false);
      setEditingId(dish.id);
      setFormMode('menu');
      setShowForm(true);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      showToast(`โหลดเมนูไม่สำเร็จ: ${err.message}`);
    } finally {
      setLoadingEditId(null);
    }
  };

  // Delete the dish being edited. Like every other write on this screen nothing
  // is changed in local state: the backend removes the rows, re-reads the menu
  // and pushes it over SSE, so the row disappears from every open tab at once.
  // The dish's คลังวัตถุดิบ row (if it has one) is deliberately left alone — the
  // stockroom count is its own record, cleared from the คลัง tab.
  const handleDelete = async () => {
    if (!editingId || deleting) return;
    const name = form.name.trim();
    setDeleting(true);
    try {
      const res = await deleteMenuItem(editingId);
      showToast(
        res?.stockRemoved
          ? `ลบเมนู [${name}] และรายการในคลังแล้ว`
          : `ลบเมนู [${name}] แล้ว`
      );
      resetForm();
      setShowForm(false);
    } catch (err) {
      showToast(`ลบเมนูไม่สำเร็จ: ${err.message}`);
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handlePickImage = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      // Shrink first: a 5 MB phone photo becomes ~200 KB, which is both under
      // the server's cap and quick to send over mobile data.
      const small = await shrinkImage(file);
      const { url } = await uploadMenuImage(small);
      setForm((f) => ({ ...f, imageUrl: url }));
      setImagePreview(URL.createObjectURL(small));
      showToast('อัปโหลดรูปภาพเรียบร้อย');
    } catch (err) {
      showToast(`อัปโหลดรูปไม่สำเร็จ: ${err.message}`);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } finally {
      setUploading(false);
    }
  };

  const handleClearImage = () => {
    setForm((f) => ({ ...f, imageUrl: '' }));
    setImagePreview('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const updateVariant = (index, patch) =>
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    if (!form.name.trim()) return showToast('กรุณากรอกชื่อรายการ');
    if (!form.category.trim()) return showToast('กรุณาเลือกหมวดหมู่');

    // With no protein choices the dish's own price is what is charged; with
    // choices, each option carries its own and the dish price is derived.
    const filled = variants.filter((v) => v.meat.trim());
    if (!filled.length) {
      const price = Number(form.price);
      if (!Number.isFinite(price) || price < 0) {
        return showToast('กรุณากรอกราคาเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
      }
    } else if (filled.some((v) => !Number.isFinite(Number(v.price)) || Number(v.price) < 0)) {
      return showToast('กรุณากรอกราคาของทุกตัวเลือกให้ถูกต้อง');
    }

    // Stock mode needs a starting quantity for a new inventory row; editing a
    // dish that is already in the คลัง needs its corrected on-hand count. Both
    // read the same field, so validate it whenever it is on screen.
    let quantity = 0;
    if (formMode === 'stock' || (editingId && editStock)) {
      quantity = Number(form.quantity);
      if (!Number.isInteger(quantity) || quantity < 0) {
        return showToast('กรุณากรอกจำนวนในคลังเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
      }
    }

    setSaving(true);
    // The English fields have to be in every payload, not only when the owner
    // typed one: saving a dish rewrites its rows from this object, so a field
    // left out here is a translation deleted from the database.
    const payload = {
      category: form.category.trim(),
      type: form.type.trim() || 'เมนูหลัก',
      subcategory: form.subcategory.trim(),
      subcategoryEn: form.subcategoryEn.trim(),
      name: form.name.trim(),
      nameEn: form.nameEn.trim(),
      theme: formTheme,
      imageUrl: form.imageUrl,
      variants: filled.length
        ? filled.map((v) => ({
            meat: v.meat.trim(),
            meatEn: (v.meatEn || '').trim(),
            price: Number(v.price),
          }))
        : [{ meat: '-', meatEn: '', price: Number(form.price) }],
    };
    try {
      if (editingId) {
        // Editing an existing dish: overwrite its rows. If the dish is in the
        // คลัง and the owner changed จำนวนปัจจุบัน, write the difference to the
        // stock row too (best-effort — the menu edit still counts if it fails).
        // The คลัง row's photo is mirrored by the SERVER as part of this call
        // (see setStockImageByName) — matching by name is the database's job,
        // not the browser's. It answers with whether a row actually took it.
        const saved = await updateMenuItem(editingId, payload);
        let stockMsg = saved?.stockImageUpdated ? ' · อัปเดตรูปในคลังแล้ว' : '';
        if (editStock) {
          const delta = quantity - editStock.quantity;
          if (delta !== 0) {
            try {
              const item = await adjustStockItem(editStock.id, delta, 'แก้ไขจำนวนจากหน้าจัดการเมนู');
              stockMsg = ` · ปรับคลังเหลือ ${item.quantity}`;
            } catch (stockErr) {
              stockMsg = ` แต่ปรับจำนวนคลังไม่สำเร็จ: ${stockErr.message}`;
            }
          }
        }
        showToast(`แก้ไขเมนู [${form.name.trim()}] เรียบร้อย${stockMsg}`);
      } else {
        // In stock mode the server files the same item in คลังวัตถุดิบ as part of
        // this call (see POST /api/menu/items). The menu success stands even if
        // the stock half fails — the reply says so, and so does the toast.
        const saved = await createMenuItem(
          formMode === 'stock' ? { ...payload, stockQuantity: quantity } : payload
        );
        let stockMsg = ' เรียบร้อย';
        if (saved?.stockItem) stockMsg = ` และบันทึกลงคลังแล้ว (คงเหลือ ${saved.stockItem.quantity})`;
        else if (saved?.stockError) stockMsg = ` แต่บันทึกลงคลังไม่สำเร็จ: ${saved.stockError}`;
        showToast(`เพิ่มเมนู [${form.name.trim()}]${stockMsg}`);
      }

      resetForm();
      setShowForm(false);
      setHeading('all');
    } catch (err) {
      showToast(`${editingId ? 'แก้ไข' : 'เพิ่ม'}เมนูไม่สำเร็จ: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">

      {/* ADD BUTTONS
          The first cell is a SPLIT button: adding a dish and editing the
          ตัวเลือกเสริม presets are both "author the menu" jobs and belong side
          by side, but they open different panels, so one control with two
          halves says that better than a third full-width button would. */}
      <div className={`grid gap-2 ${stockOnly ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {!stockOnly && (
        <div className="flex rounded-2xl overflow-hidden bg-admin-cta divide-x divide-black/10">
          <button
            onClick={() => { resetForm(); setShowForm(true); setFormMode('menu'); setFormTheme('day'); }}
            className="flex-1 hover:bg-admin-cta-hover text-admin-cta-ink font-bold py-3 px-1 transition font-kanit flex items-center justify-center gap-1 text-[11px]"
          >
            <Plus className="w-3.5 h-3.5 flex-shrink-0" />
            เพิ่มเมนูใหม่
          </button>
          <button
            onClick={() => setShowPresets(true)}
            className="flex-1 hover:bg-admin-cta-hover text-admin-cta-ink font-bold py-3 px-1 transition font-kanit flex items-center justify-center gap-1 text-[11px]"
          >
            <Pencil className="w-3.5 h-3.5 flex-shrink-0" />
            แก้ไขเมนูเสริม
          </button>
        </div>
        )}
        <button
          onClick={() => { resetForm(); setShowForm(true); setFormMode('stock'); setFormTheme('day'); }}
          className="bg-ctl hover:bg-ctl-hover text-ctl-ink font-bold py-3 rounded-2xl transition font-kanit flex items-center justify-center gap-2 text-xs"
        >
          <Plus className="w-4 h-4" />
          เพิ่มเมนูในสต็อก
        </button>
      </div>

      {showPresets && !stockOnly && (
        <AddonPresetManager
          presets={addonPresets}
          menu={menu}
          onSave={setAddonPresets}
          onClose={() => setShowPresets(false)}
          showToast={showToast}
        />
      )}

      {/* FORM — as a pop-up, so editing a dish deep in the list no longer jumps
          the whole page to the top. Bottom-sheet on phones, centred card on
          wider screens. Tapping the dim backdrop closes it. */}
      {showForm && (
        <div
          className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => { setShowForm(false); resetForm(); }}
        >
          <form
            onSubmit={handleSubmit}
            onClick={(e) => e.stopPropagation()}
            className="bg-admin-panel w-full max-w-md rounded-t-3xl sm:rounded-3xl p-4 space-y-3 text-xs font-thai max-h-[90vh] overflow-y-auto shadow-2xl"
          >
          <div className="flex justify-between items-baseline">
            <h3 className="font-extrabold text-base font-kanit text-neutral-800">{editingId ? 'แก้ไขเมนู' : formMode === 'stock' ? 'เพิ่มเมนูในสต็อก' : 'เพิ่มเมนูใหม่'}</h3>
            <button
              type="button"
              onClick={() => { setShowForm(false); resetForm(); }}
              className="text-[10px] text-neutral-500 font-bold hover:text-neutral-700"
            >
              ยกเลิก
            </button>
          </div>

          {/* SHIFT */}
          <div>
            <label className="block font-bold text-neutral-500 mb-1">กะที่ขาย</label>
            <div className="flex gap-1.5 bg-admin-card border rounded-xl p-1">
              {FORM_THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setFormTheme(t.id)}
                  className={`flex-1 py-2 rounded-lg font-bold transition ${t.id === formTheme ? 'bg-ctl text-ctl-ink' : 'text-neutral-500'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <ComboBox
            label="หมวดหมู่"
            value={form.category}
            options={options.categories}
            onChange={handleCategoryChange}
            placeholder="เช่น อาหาร, เครื่องดื่ม"
            required
          />

          <div className="grid grid-cols-2 gap-2">
            <ComboBox
              label="ประเภท"
              value={form.type}
              options={options.types}
              onChange={(v) => setForm((f) => ({ ...f, type: v }))}
              placeholder="เช่น เมนูหลัก"
            />
            {/* Narrowed to the chosen หมวดหมู่ — see subcategoryOptions above.
                Picking a known หัวข้อ auto-fills its English below; a new/unknown
                one leaves whatever EN the owner typed untouched. */}
            <ComboBox
              label="หัวข้อ"
              value={form.subcategory}
              options={subcategoryOptions}
              onChange={(v) => setForm((f) => {
                const en = subcategoryEnByName.get(v);
                return { ...f, subcategory: v, subcategoryEn: en != null ? en : f.subcategoryEn };
              })}
              placeholder={form.category ? `หัวข้อของ${form.category}` : 'เช่น เมนูราดข้าว'}
            />
          </div>

          {/* หัวข้อ (EN) sits right under the หัวข้อ combo it translates. It is
              stored per dish row, so changing it here retitles this dish only —
              a heading shared with other dishes has to be retranslated on each. */}
          <div>
            <label className="block font-bold text-neutral-500 mb-1">
              หัวข้อ (EN) <span className="font-medium text-neutral-400">— ไม่บังคับ</span>
            </label>
            <input
              type="text"
              value={form.subcategoryEn}
              onChange={(e) => setForm((f) => ({ ...f, subcategoryEn: e.target.value }))}
              placeholder="e.g. Rice Dishes"
              className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
            />
          </div>

          <div>
            <label className="block font-bold text-neutral-500 mb-1">ชื่อรายการ</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="เช่น ทอดน้ำปลาราดข้าว"
              required
              className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
            />
          </div>

          <div>
            <label className="block font-bold text-neutral-500 mb-1">
              ชื่อรายการ (EN) <span className="font-medium text-neutral-400">— ไม่บังคับ</span>
            </label>
            <input
              type="text"
              value={form.nameEn}
              onChange={(e) => setForm((f) => ({ ...f, nameEn: e.target.value }))}
              placeholder="e.g. Fried Fish Sauce Rice"
              className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
            />
            <p className="text-[10px] text-neutral-400 font-medium mt-1">
              เว้นว่างได้ — เมนูภาษาอังกฤษจะแสดงชื่อภาษาไทยแทน
            </p>
          </div>

          {/* PRICE — only when the dish has no protein choices to price */}
          {variants.length === 0 && (
            <div>
              <label className="block font-bold text-neutral-500 mb-1">ราคา (บาท)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                placeholder="กรอกตัวเลข ฿"
                required
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold"
              />
            </div>
          )}

          {/* STOCK QUANTITY — only in เพิ่มเมนูในสต็อก mode */}
          {formMode === 'stock' && (
            <div>
              <label className="block font-bold text-neutral-500 mb-1">จำนวนในคลัง (เริ่มต้น)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={form.quantity}
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                placeholder="เช่น 50"
                required
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold"
              />
              <p className="text-[10px] text-neutral-400 font-medium mt-1">
                จะบันทึกลงคลังวัตถุดิบด้วย ชื่อตรงกับเมนูเพื่อให้หน้าลูกค้าซ่อนอัตโนมัติเมื่อของหมด
              </p>
            </div>
          )}

          {/* CURRENT STOCK — only when editing a dish that has a คลังวัตถุดิบ row
              (drinks / stocked items). Lets the owner correct the on-hand count
              straight from the edit form; the difference is written to the คลัง. */}
          {editingId && editStock && (
            <div>
              <label className="block font-bold text-neutral-500 mb-1">จำนวนปัจจุบัน (คงเหลือในคลัง)</label>
              <input
                type="number"
                min="0"
                step="1"
                value={form.quantity}
                onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                placeholder="เช่น 50"
                required
                className="w-full border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold"
              />
              <p className="text-[10px] text-neutral-400 font-medium mt-1">
                เดิมมี {editStock.quantity} — แก้ตัวเลขนี้เพื่อปรับจำนวนคงเหลือในคลังวัตถุดิบ
              </p>
            </div>
          )}

          {/* PROTEIN OPTIONS */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="font-bold text-neutral-500">ตัวเลือกเนื้อสัตว์</label>
              <button
                type="button"
                onClick={() => setVariants((v) => [...v, { meat: '', meatEn: '', price: form.price || '' }])}
                className="text-[10px] font-extrabold text-amber-700 hover:text-amber-900"
              >
                + เพิ่มตัวเลือก
              </button>
            </div>

            {variants.length === 0 ? (
              <p className="text-[10px] text-neutral-400 font-medium">
                ไม่มีตัวเลือก = ขายราคาเดียว (เช่น ข้าวสวย)
              </p>
            ) : (
              <>
                {/* Two rows per option: Thai + price + delete, then its English
                    name underneath. The EN box is indented so the pair reads as
                    one option rather than two. */}
                {variants.map((v, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex gap-1.5">
                      {/* Dropdown of เนื้อสัตว์ already used elsewhere, plus a
                          "พิมพ์ใหม่เอง" escape hatch. Picking a known one fills its
                          English below automatically; a brand-new one is typed. */}
                      {(v.custom || (v.meat && !meatOptions.includes(v.meat))) ? (
                        <div className="flex-1 min-w-0 flex gap-1">
                          <input
                            type="text"
                            value={v.meat}
                            onChange={(e) => updateVariant(i, { meat: e.target.value })}
                            placeholder="เช่น หมู, ไก่, ทะเล"
                            autoFocus
                            className="flex-1 min-w-0 border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                          />
                          {meatOptions.length > 0 && (
                            <button
                              type="button"
                              onClick={() => updateVariant(i, { custom: false, meat: '' })}
                              className="px-2 rounded-xl border text-neutral-500 hover:bg-neutral-50 transition"
                              title="เลือกจากรายการเดิม"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ) : (
                        <select
                          value={v.meat}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === '__custom__') {
                              updateVariant(i, { custom: true, meat: '', meatEn: '' });
                              return;
                            }
                            const en = meatEnByName.get(val);
                            updateVariant(i, { meat: val, meatEn: en != null ? en : (v.meatEn || '') });
                          }}
                          className="flex-1 min-w-0 border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
                        >
                          <option value="">— เลือกเนื้อสัตว์ —</option>
                          {meatOptions.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                          <option value="__custom__">+ พิมพ์ใหม่เอง…</option>
                        </select>
                      )}
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={v.price}
                        onChange={(e) => updateVariant(i, { price: e.target.value })}
                        placeholder="฿"
                        className="w-20 border rounded-xl p-2.5 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono font-bold"
                      />
                      <button
                        type="button"
                        onClick={() => setVariants((prev) => prev.filter((_, idx) => idx !== i))}
                        className="px-2.5 text-red-400 hover:text-red-600 hover:bg-red-500/10 rounded-xl transition"
                        title="ลบตัวเลือก"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <input
                      type="text"
                      value={v.meatEn || ''}
                      onChange={(e) => updateVariant(i, { meatEn: e.target.value })}
                      placeholder={v.meat ? `English of "${v.meat}"` : 'e.g. Pork (EN — ไม่บังคับ)'}
                      className="w-full ml-3 border rounded-xl p-2 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500 text-[11px]"
                      style={{ width: 'calc(100% - 0.75rem)' }}
                    />
                  </div>
                ))}
                <p className="text-[10px] text-neutral-400 font-medium">
                  ต้องมีอย่างน้อย 2 ตัวเลือก ลูกค้าจึงจะเห็นเป็นตัวเลือกให้กด
                </p>
              </>
            )}
          </div>

          {/* IMAGE */}
          <div>
            <label className="block font-bold text-neutral-500 mb-1">รูปภาพ</label>
            {form.imageUrl ? (
              <div className="flex items-center gap-3 bg-admin-card border rounded-xl p-2.5">
                <img
                  src={imagePreview || resolveImageUrl(form.imageUrl)}
                  alt=""
                  className="w-16 h-16 rounded-xl object-cover flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <span className="block font-bold text-neutral-700">อัปโหลดแล้ว</span>
                  <span className="block text-[10px] text-neutral-400 font-mono truncate">
                    {form.imageUrl}
                  </span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="เปลี่ยนรูป"
                    title="เปลี่ยนรูป"
                    className="p-2 rounded-lg text-amber-700 hover:bg-amber-500/10 transition"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleClearImage}
                    aria-label="ลบรูป"
                    title="ลบรูป"
                    className="p-2 rounded-lg text-red-500 hover:bg-red-500/10 transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full border border-dashed border-neutral-300 rounded-xl p-4 bg-admin-card text-neutral-500 font-bold flex items-center justify-center gap-2 hover:border-amber-400 hover:text-amber-700 transition disabled:opacity-50"
              >
                {uploading ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> กำลังอัปโหลด…</>
                ) : (
                  <><ImageUp className="w-4 h-4" /> เลือกรูป หรือถ่ายภาพ</>
                )}
              </button>
            )}
            {/* accept="image/*" lets a phone offer its camera as well as the
                photo library. The file is downscaled before it is sent. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePickImage}
              className="hidden"
            />
          </div>

          <button
            type="submit"
            disabled={saving || uploading || deleting}
            className="w-full bg-admin-cta hover:bg-admin-cta-hover text-admin-cta-ink font-bold py-3 rounded-2xl transition font-kanit disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saving ? 'กำลังบันทึก…' : editingId ? 'บันทึกการแก้ไข' : (formMode === 'stock' ? 'บันทึกเมนู + คลัง' : 'บันทึกเมนูใหม่')}
          </button>

          {/* DELETE — only when editing an existing dish, and never as a single
              tap: the first press arms it, the second one actually deletes. The
              reversible alternative (ซ่อน = the sun/moon pill off) is spelled out
              here, because most of the time that is what the owner really wants. */}
          {editingId && (
            <div className="pt-1 border-t">
              {confirmDelete ? (
                <div className="space-y-2 pt-2">
                  <p className="text-[11px] font-bold text-red-600 text-center">
                    ลบ [{form.name.trim() || 'เมนูนี้'}] ออกจากเมนูถาวร?
                  </p>
                  <p className="text-[10px] text-neutral-400 font-medium text-center">
                    กู้คืนไม่ได้ — ถ้าแค่ต้องการหยุดขายชั่วคราว ให้ปิดปุ่ม ☀/🌙 หน้ารายการแทน
                  </p>
                  {/* Says the คลัง half out loud: a delete now clears the
                      stockroom row too, and that number is not coming back. */}
                  {editStock && (
                    <p className="text-[10px] text-red-500 font-bold text-center bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
                      รายการนี้อยู่ในคลังวัตถุดิบด้วย (คงเหลือ {editStock.quantity}) —
                      จะถูกลบออกจากคลังพร้อมกัน
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="py-2.5 rounded-2xl border font-bold text-neutral-600 hover:bg-neutral-50 transition disabled:opacity-50"
                    >
                      ไม่ลบ
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="py-2.5 rounded-2xl bg-red-600 hover:bg-red-700 text-white font-bold transition disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
                      {deleting ? 'กำลังลบ…' : 'ยืนยันลบ'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={saving || deleting}
                  className="w-full mt-2 py-2.5 rounded-2xl border border-red-300 text-red-600 font-bold hover:bg-red-500/10 transition disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  ลบเมนูนี้
                </button>
              )}
            </div>
          )}
          </form>
        </div>
      )}

      {/* FILTERS */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นหาชื่อเมนู"
            className="w-full border rounded-xl py-2.5 pl-9 pr-3 bg-admin-field text-xs focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold"
          />
        </div>

        {/* หัวข้อ filter — a dropdown (was a tab row), plus ⬆⬇ to reorder the
            selected หัวข้อ. Moving it here shifts the whole section for the
            customer; disabled when it is already at the top/bottom. */}
        <div className="flex gap-1.5 items-center">
          <select
            value={heading}
            onChange={(e) => setHeading(e.target.value)}
            className="flex-1 min-w-0 border rounded-xl p-2.5 bg-admin-field text-xs focus:outline-none focus:ring-1 focus:ring-amber-500 font-bold font-thai"
          >
            <option value="all">ทั้งหมด</option>
            {headings.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
          {/* Not for ผู้จัดการคลัง: a หัวข้อ carries dishes outside the คลัง too,
              and moving it would move those with it. */}
          {heading !== 'all' && !stockOnly && (
            <>
              <button
                type="button"
                onClick={() => moveHeading(-1)}
                disabled={savingOrder || headings.indexOf(heading) <= 0}
                title="เลื่อนหัวข้อนี้ขึ้น (แสดงก่อน)"
                aria-label="เลื่อนหัวข้อนี้ขึ้น"
                className="p-2.5 rounded-xl border bg-admin-card text-neutral-600 hover:bg-neutral-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => moveHeading(1)}
                disabled={savingOrder || headings.indexOf(heading) >= headings.length - 1}
                title="เลื่อนหัวข้อนี้ลง (แสดงทีหลัง)"
                aria-label="เลื่อนหัวข้อนี้ลง"
                className="p-2.5 rounded-xl border bg-admin-card text-neutral-600 hover:bg-neutral-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* LIST */}
      <div className="flex justify-between items-center pl-1 text-[10px] font-bold text-neutral-400">
        <span>{visible.length} รายการ</span>
        <span className="flex items-center gap-2">
          {savingOrder && (
            <span className="flex items-center gap-1 text-neutral-500">
              <Loader2 className="w-3 h-3 animate-spin" /> กำลังบันทึกลำดับ…
            </span>
          )}
          {hiddenCount > 0 && <span className="text-red-500">ซ่อนอยู่ {hiddenCount} รายการ</span>}
        </span>
      </div>

      <p className="pl-1 text-[10px] text-neutral-400 font-medium">
        ลากปุ่ม ☰ หน้ารูปเพื่อจัดลำดับ — ลำดับนี้คือลำดับที่ลูกค้าเห็นในหน้าสั่งอาหาร
      </p>

      {stockOnly && (
        <p className={`pl-1 text-[10px] font-medium ${stockNamesError ? 'text-red-500' : 'text-amber-700'}`}>
          {stockNamesError
            ? `โหลดรายการในคลังไม่สำเร็จ: ${stockNamesError}`
            : stockNames
              ? 'แสดงเฉพาะเมนูที่อยู่ในคลังวัตถุดิบ'
              : 'กำลังโหลดรายการในคลัง…'}
        </p>
      )}

      <div className="bg-admin-card border rounded-2xl overflow-hidden shadow-xs divide-y divide-neutral-100">
        {rows.length > 0 ? (
          rows.map((dish, index) => {
            const busy = pending.has(dish.id);
            const shifts = shiftsFromTheme(dish.theme || 'day');
            // The held row follows the finger: its travel less the distance the
            // preview has already shifted it, so it sits under the fingertip
            // whether or not the list has re-slotted it yet.
            const held = drag?.id === dish.id;
            const lift = held ? drag.dy - (drag.toIndex - drag.fromIndex) * drag.height : 0;
            return (
              <div
                key={dish.id}
                data-dish-row
                className={`flex items-center gap-2.5 px-3 py-2.5 font-thai bg-admin-card ${held ? 'relative z-10 shadow-lg rounded-xl' : ''}`}
                style={held ? { transform: `translateY(${lift}px)`, touchAction: 'none' } : undefined}
              >
                {/* DRAG HANDLE — ลากเพื่อจัดลำดับ */}
                <button
                  type="button"
                  onPointerDown={(e) => handleDragStart(e, index, dish)}
                  onPointerMove={handleDragMove}
                  onPointerUp={handleDragEnd}
                  onPointerCancel={handleDragCancel}
                  onKeyDown={(e) => handleHandleKeyDown(e, index)}
                  aria-label={`จัดลำดับ ${dish.name}`}
                  title="ลากขึ้น-ลงเพื่อจัดลำดับเมนู (หรือกดปุ่มลูกศรขึ้น/ลง)"
                  // touch-action:none, or the browser claims the gesture as a
                  // page scroll and the row never moves on a phone.
                  style={{ touchAction: 'none' }}
                  className={`-ml-1 p-1 flex-shrink-0 rounded-lg text-neutral-300 hover:text-neutral-500 hover:bg-neutral-100 transition cursor-grab active:cursor-grabbing ${held ? 'text-neutral-500 bg-neutral-100' : ''}`}
                >
                  <GripLines className="w-4 h-4" />
                </button>

                <div className="w-11 h-11 rounded-xl bg-neutral-100 flex items-center justify-center text-xl overflow-hidden flex-shrink-0">
                  {dish.image
                    ? <img src={resolveImageUrl(dish.image)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    : <span>{dish.emoji || '🍽️'}</span>}
                </div>

                <div className="flex-1 min-w-0">
                  {/* Name always shown normally — the empty sun/moon pill is the
                      only "hidden" cue, matching the design mock. */}
                  <span className="block font-bold text-xs truncate text-neutral-800">
                    {dish.name}
                  </span>
                  <span className="block text-[10px] text-neutral-400 font-medium truncate">
                    {dish.category}
                    {dish.options?.length > 0 && ` • ${dish.options.length} ตัวเลือก`}
                    {' • '}
                    <span className="font-mono">฿{dish.price}</span>
                  </span>
                </div>

                {/* SHIFT PILL — sun = show by day, moon = show by night. Neither lit
                    = hidden everywhere. Each segment toggles independently. */}
                <div className={`inline-flex rounded-full border-2 border-wood-dark overflow-hidden flex-shrink-0 ${busy ? 'opacity-50' : ''}`}>
                  <button
                    onClick={() => handleToggleShift(dish, 'day')}
                    disabled={busy}
                    aria-pressed={shifts.day}
                    aria-label={`${shifts.day ? 'ปิด' : 'เปิด'}การแสดงตอนกลางวัน ${dish.name}`}
                    title={shifts.day ? 'แสดงตอนกลางวัน (กดเพื่อปิด)' : 'ไม่แสดงตอนกลางวัน (กดเพื่อเปิด)'}
                    className={`px-3 py-1.5 transition ${shifts.day ? 'bg-wood text-white' : 'text-wood-dark hover:bg-wood/10'}`}
                  >
                    <Sun className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleToggleShift(dish, 'night')}
                    disabled={busy}
                    aria-pressed={shifts.night}
                    aria-label={`${shifts.night ? 'ปิด' : 'เปิด'}การแสดงตอนกลางคืน ${dish.name}`}
                    title={shifts.night ? 'แสดงตอนกลางคืน (กดเพื่อปิด)' : 'ไม่แสดงตอนกลางคืน (กดเพื่อเปิด)'}
                    className={`px-3 py-1.5 border-l-2 border-wood-dark transition ${shifts.night ? 'bg-wood text-white' : 'text-wood-dark hover:bg-wood/10'}`}
                  >
                    <Moon className="w-4 h-4" />
                  </button>
                </div>

                {/* EDIT (pencil) */}
                <button
                  onClick={() => startEdit(dish)}
                  disabled={loadingEditId === dish.id}
                  aria-label={`แก้ไข ${dish.name}`}
                  title="แก้ไขเมนู (ชื่อ ราคา ฯลฯ)"
                  className="w-9 h-9 rounded-full border-2 border-wood-dark flex items-center justify-center text-wood-dark hover:bg-wood/10 transition disabled:opacity-50 flex-shrink-0"
                >
                  {loadingEditId === dish.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Pencil className="w-4 h-4" />}
                </button>
              </div>
            );
          })
        ) : (
          <p className="text-neutral-400 text-xs py-6 text-center font-medium">
            ไม่พบเมนูที่ตรงกับเงื่อนไข
          </p>
        )}
      </div>
    </div>
  );
}

export default OwnerMenu;
