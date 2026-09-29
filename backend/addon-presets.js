// ---------------------------------------------------------------------------
// ตัวเลือกเสริม (add-on presets)
// ---------------------------------------------------------------------------
// A preset is one reusable set of extras — ตัวเลือกเสริม, ท็อปปิ้ง, ระดับความหวาน —
// that the owner builds once and attaches to whichever dishes should offer it:
//
//   { id, name, nameEn, mode: 'single' | 'multi', options: [...], menuIds: [...] }
//
//   mode 'multi'  — tick as many as you like (ไข่ดาว, ไข่มุก)   -> shown as addons
//   mode 'single' — pick exactly one (ระดับความหวาน, ขนาด)      -> shown as a radio
//
// WHY THIS FILE EXISTS SEPARATELY FROM addons/choices
// state.addons and state.choices are DERIVED: syncMenuFromDb rebuilds them from
// the `รายการเสริม` rows of menu_items every 30 seconds, so anything the owner
// edits there is overwritten within half a minute. Presets are owner-authored
// data with no row in menu_items to come from, so they live in their own
// resource that the sync never touches.
//
// The classification rules below are a deliberate copy of the ones in
// frontend/src/menu-groups.js. They exist here only to REPLAY the old behaviour
// once, during migration, so the presets that get generated offer each dish
// exactly what it offered the day before. Keep the two in step if the old rules
// ever change; after migration nothing reads them again.
// ---------------------------------------------------------------------------

const DRINK_CATEGORIES = new Set([
  'เครื่องดื่ม', 'ชา', 'ชาผลไม้', 'กาแฟ', 'โกโก้ นม', 'น้ำผลไม้โซดา', 'ท็อปปิ้ง',
]);
const NO_FOOD_ADDON_HEADINGS = new Set(['ผ้าเย็น', 'ของหวาน', 'ขนมหวาน', 'ขนมขบเคี้ยว']);
const PACKAGED_DRINK_HEADINGS = new Set([
  'น้ำดื่ม', 'น้ำเปล่า', 'น้ำอัดลม',
  'เบียร์', 'เบียร์คราฟต์', 'เบียร์ขาว',
  'ไวน์', 'ไวน์คูลเลอร์', 'ไซเดอร์', 'บรั่นดี รัม',
]);

const isDrinkItem = (item) =>
  item?.group ? item.group === 'drink' : DRINK_CATEGORIES.has(item?.category);
const isPackagedDrink = (item) => PACKAGED_DRINK_HEADINGS.has(item?.category);

// The per-shift { food, drink } pair out of a store written in either the
// current scoped shape or the flat legacy one. Mirrors bucketsFor().
function bucketsFor(store, theme) {
  const scoped = store?.[theme];
  if (scoped && !Array.isArray(scoped) && (Array.isArray(scoped.food) || Array.isArray(scoped.drink))) {
    return { food: scoped.food || [], drink: scoped.drink || [] };
  }
  if (theme === 'night') {
    const flat = Array.isArray(store?.night) ? store.night : [];
    return { food: flat, drink: flat };
  }
  return { food: store?.food || [], drink: store?.drink || [] };
}

function legacyAddonsFor(addons, theme, item) {
  if (isPackagedDrink(item)) return [];
  const buckets = bucketsFor(addons, theme);
  if (isDrinkItem(item)) return buckets.drink;
  if (NO_FOOD_ADDON_HEADINGS.has(item?.category)) return [];
  return buckets.food;
}

function legacyChoicesFor(choices, theme, item) {
  if (isPackagedDrink(item)) return [];
  const buckets = bucketsFor(choices, theme);
  return isDrinkItem(item) ? buckets.drink : buckets.food;
}

// The shift(s) a dish is actually sold in. A 'both' dish is priced into each
// storefront, so during migration it is offered whatever EITHER shift gave it.
function themesFor(theme) {
  if (theme === 'both') return ['day', 'night'];
  if (theme === 'none') return [];
  return [theme === 'night' ? 'night' : 'day'];
}

let idSeq = 0;
const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Two option lists are "the same preset" when they offer the same names at the
// same prices. Day and night usually do, and collapsing them keeps the owner's
// screen from opening on four near-identical copies of ตัวเลือกเสริม.
const optionSignature = (mode, options) =>
  `${mode}|${options.map((o) => `${o.name}:${o.price || 0}`).join('|')}`;

const SHIFT_LABEL = { day: 'กลางวัน', night: 'กลางคืน' };

// The base name a generated preset gets before disambiguation. The main food
// one is named exactly ตัวเลือกเสริม (Default) — it is the ไข่ดาว/ไข่เจียว set
// behind most dishes and the one the owner will go looking for first.
const baseLabel = (mode, group, groupName) =>
  mode === 'single'
    ? groupName
    : group === 'drink'
      ? 'ท็อปปิ้ง (Default)'
      : 'ตัวเลือกเสริม (Default)';

// Day and night keep separate lists whenever they differ, which leaves two
// presets wanting the same name. Rather than number them — "(Default) 2" says
// nothing about what it is — the clashing ones are labelled by the shift they
// came from. A name used only once is left exactly as it is.
function disambiguateNames(presets) {
  const count = new Map();
  for (const p of presets) count.set(p.name, (count.get(p.name) || 0) + 1);
  const used = new Set();
  for (const p of presets) {
    if (count.get(p.name) > 1) {
      const suffix = SHIFT_LABEL[p.theme];
      if (suffix) p.name = `${p.name} · ${suffix}`;
    }
    // Belt and braces: two shifts could still collide if a name repeated for
    // some other reason.
    while (used.has(p.name)) p.name = `${p.name} ‧`;
    used.add(p.name);
  }
  return presets;
}

// Turn the derived addons/choices into presets, and link every dish to the ones
// it is already being offered. Nothing about ordering changes: a dish that saw
// ไข่ดาว yesterday sees the same ไข่ดาว today, now through a preset the owner
// can actually edit.
//
// Returns [] when there is nothing to convert (no menu yet), which the caller
// reads as "not migrated" and retries after the next menu sync.
export function buildPresetsFromLegacy(menu, addons, choices) {
  if (!Array.isArray(menu) || !menu.length) return [];

  const bySignature = new Map(); // signature -> preset

  // Find (or create) the preset for one legacy list, then link `item` to it.
  const linkTo = (mode, options, group, theme, item) => {
    if (!options?.length) return;
    const signature = optionSignature(mode, options);
    let preset = bySignature.get(signature);
    if (!preset) {
      preset = {
        id: newId('preset'),
        // A single-pick group arrives already named (ขนาด, ระดับความหวาน); a
        // tick-box list is nameless and gets the (Default) label.
        name: baseLabel(mode, group, options.groupName),
        // Which shift first produced this list, kept only long enough for
        // disambiguateNames to label a clash with it.
        theme,
        nameEn: options.groupNameEn || '',
        mode,
        options: options.map((o) => ({
          id: newId('opt'),
          name: o.name,
          nameEn: o.nameEn || '',
          price: Number(o.price) || 0,
        })),
        menuIds: [],
        // Marks a preset the migration wrote rather than the owner. Purely
        // informational — it is editable and deletable like any other.
        source: 'migration',
      };
      bySignature.set(signature, preset);
    }
    if (!preset.menuIds.includes(item.id)) preset.menuIds.push(item.id);
  };

  for (const item of menu) {
    for (const theme of themesFor(item.theme)) {
      const group = isDrinkItem(item) ? 'drink' : 'food';
      linkTo('multi', legacyAddonsFor(addons, theme, item), group, theme, item);
      for (const choiceGroup of legacyChoicesFor(choices, theme, item)) {
        const options = [...(choiceGroup.options || [])];
        options.groupName = choiceGroup.name;
        options.groupNameEn = choiceGroup.nameEn;
        linkTo('single', options, group, theme, item);
      }
    }
  }

  // Pick-one groups first: they are the ones a dish must answer before it can
  // be ordered, so they read better at the top of the owner's list.
  const ordered = [...bySignature.values()].sort((a, b) =>
    (a.mode === b.mode ? 0 : a.mode === 'single' ? -1 : 1)
  );
  return disambiguateNames(ordered);
}

// Shape/size guard for a preset list arriving from the owner's browser. Returns
// an error string, or null when the body is safe to store.
export function validateAddonPresets(body) {
  if (!Array.isArray(body)) return 'addonPresets must be an array';
  if (body.length > 200) return 'too many presets';
  for (const p of body) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'each preset must be an object';
    if (!p.id || typeof p.id !== 'string') return 'each preset needs an id';
    if (typeof p.name !== 'string' || !p.name.trim()) return 'each preset needs a name';
    if (p.mode !== 'single' && p.mode !== 'multi') return 'mode must be "single" or "multi"';
    if (!Array.isArray(p.options) || p.options.length > 100) return 'options must be a list of at most 100';
    if (!p.options.every((o) => o && typeof o === 'object' && typeof o.name === 'string')) {
      return 'each option needs a name';
    }
    if (!Array.isArray(p.menuIds) || p.menuIds.length > 5000) return 'menuIds must be a list';
    if (!p.menuIds.every((id) => typeof id === 'string')) return 'menuIds must be dish ids';
  }
  return null;
}
