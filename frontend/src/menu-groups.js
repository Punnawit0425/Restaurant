// Which storefront a menu item belongs to, and which extras go with it.
// Shared by CustomerView and StaffView so the two order dialogs can never
// drift apart on what they offer.

// Items synced from the Google Sheet carry `group` ('food' | 'drink') straight
// from its หมวดหมู่ column. This list is only a fallback for items that predate
// that field: the hand-curated night menu, or a stored menu from an older sync.
export const DRINK_CATEGORIES = new Set([
  'เครื่องดื่ม',
  'ชา',
  'ชาผลไม้',
  'กาแฟ',
  'โกโก้ นม',
  'น้ำผลไม้โซดา',
  'ท็อปปิ้ง',
]);

export function isDrinkItem(item) {
  if (!item) return false;
  return item.group ? item.group === 'drink' : DRINK_CATEGORIES.has(item.category);
}

// Headings (the menu's หัวข้อ, exposed as `category`) that are served straight to
// the table — cold towels, desserts, pre-packed snacks. Like drinks, they take
// no plated-food extras: a ผ้าเย็น or ข้าวเหนียวมะม่วง should never offer ไข่ดาว,
// สั่งกลับบ้าน or เป็นกับข้าว. Mirrors NON_KITCHEN_HEADINGS in kitchen.js.
const NO_FOOD_ADDON_HEADINGS = new Set(['ผ้าเย็น', 'ของหวาน', 'ขนมหวาน', 'ขนมขบเคี้ยว']);

// Headings for drinks that come pre-packaged from stock — bottled/canned, served
// as-is (น้ำในสต็อก): water, soft drinks, beer, wine, spirits, ciders. Unlike a
// made-to-order cup (ชา, กาแฟ, โกโก้, ชาผลไม้, น้ำผลไม้โซดา), a sealed can of โค้ก
// or a bottle of เบียร์ can't be "50% sweet", take ไข่มุก, or be poured into a
// bigger cup — it comes in the size it comes in. So it offers no sweetness
// level, no toppings and no ขนาด.
const PACKAGED_DRINK_HEADINGS = new Set([
  'น้ำดื่ม', 'น้ำเปล่า', 'น้ำอัดลม',
  'เบียร์', 'เบียร์คราฟต์', 'เบียร์ขาว',
  'ไวน์', 'ไวน์คูลเลอร์', 'ไซเดอร์', 'บรั่นดี รัม',
]);

function isPackagedDrink(item) {
  return PACKAGED_DRINK_HEADINGS.has(item?.category);
}

// The { food, drink } pair belonging to ONE storefront.
//
// เรินเก่า (night) and the day shop run the exact same rules, but not the same
// lists: each keeps its own extras, so adding a bar topping to the night menu
// never makes it appear on a day ชาเย็น. That is why the buckets are scoped by
// theme — `addons.night.drink`, `choices.day.food`, and so on.
//
// The older shape is still understood, so stored state written before this
// scoping (day at the top level, night as ONE flat list) keeps working until the
// next menu sync rewrites it.
function bucketsFor(store, theme) {
  const scoped = store?.[theme];
  if (scoped && !Array.isArray(scoped) && (Array.isArray(scoped.food) || Array.isArray(scoped.drink))) {
    return { food: scoped.food || [], drink: scoped.drink || [] };
  }
  if (theme === 'night') {
    // Legacy: one undivided night list. It was shown for every night dish, so
    // that is what both halves fall back to.
    const flat = Array.isArray(store?.night) ? store.night : [];
    return { food: flat, drink: flat };
  }
  return { food: store?.food || [], drink: store?.drink || [] };
}

// Bring a stored addons/choices object into the per-shift shape, whichever shape
// it arrived in. Called once when state lands from the backend, so everything
// downstream reads one predictable structure instead of guessing per lookup.
export function normalizeGroupStore(store) {
  return {
    day: bucketsFor(store, 'day'),
    night: bucketsFor(store, 'night'),
  };
}

// Extras to offer for one dish. Food and drinks get different lists — a bowl of
// ต้มข่าไก่ should not offer ไข่มุก, and a ชาเย็น should not offer ไข่ดาว. Both
// storefronts are screened by the same rules.
export function addonsFor(addons, theme, item) {
  // Packaged drinks (bottled/canned) take no extras (no toppings) in any storefront.
  if (isPackagedDrink(item)) return [];
  const buckets = bucketsFor(addons, theme);
  if (isDrinkItem(item)) return buckets.drink;
  // Non-course food (desserts, snacks, cold towels) offers no plated-food extras.
  if (NO_FOOD_ADDON_HEADINGS.has(item?.category)) return [];
  return buckets.food;
}

// Pick-exactly-one groups for one dish, e.g. ขนาด (ไซส์ M/L) and
// ระดับความหวาน for drinks. Unlike addons these always have a value.
export function choicesFor(choices, theme, item) {
  // A packaged drink is sold exactly as it comes off the shelf — neither its
  // sweetness nor its ขนาด is ours to change — so it takes no pick-one group.
  if (isPackagedDrink(item)) return [];
  const buckets = bucketsFor(choices, theme);
  return isDrinkItem(item) ? buckets.drink : buckets.food;
}

// --- ตัวเลือกเสริม presets --------------------------------------------------
// A preset is an owner-authored set of extras attached to dishes by id:
//
//   { id, name, nameEn, mode: 'single' | 'multi', options: [...], menuIds: [...] }
//
// It replaces the rules above rather than adding to them. Those rules guessed
// what a dish should offer from its heading and group; a preset is the owner
// SAYING so, dish by dish, which is both more precise and editable from the
// app. The backend converts the old lists into presets once at startup (see
// backend/addon-presets.js), so nothing about an existing dish changes.
//
// The two modes map exactly onto what the order dialogs already render:
//   'multi'  -> tick boxes (the old addons)
//   'single' -> radio buttons (the old choices)
// so no caller downstream of extrasFor has to know presets exist at all.

// Every preset attached to one dish, in the order the owner arranged them.
export function presetsForItem(presets, item) {
  if (!Array.isArray(presets) || !item?.id) return [];
  return presets.filter((p) => Array.isArray(p?.menuIds) && p.menuIds.includes(item.id));
}

// What one dish offers, as { addons, choices } in the shapes the dialogs
// already speak.
//
// `presets` being absent (not an empty array — actually undefined/null) means a
// backend that predates the migration, or one whose menu was empty when it
// booted. Falling back to the derived lists keeps that install ordering exactly
// as before instead of showing every dish with no extras at all.
export function extrasFor(presets, addons, choices, theme, item) {
  if (!Array.isArray(presets)) {
    return { addons: addonsFor(addons, theme, item), choices: choicesFor(choices, theme, item) };
  }
  const linked = presetsForItem(presets, item);
  return {
    addons: linked
      .filter((p) => p.mode !== 'single')
      .flatMap((p) =>
        (p.options || []).map((o) => ({
          // The dialogs key their tick boxes on this, and two presets may well
          // offer an option of the same name — so it is namespaced per preset.
          id: `${p.id}:${o.id || o.name}`,
          name: o.name,
          nameEn: o.nameEn || '',
          price: Number(o.price) || 0,
        }))
      ),
    choices: linked
      .filter((p) => p.mode === 'single' && (p.options || []).length > 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        nameEn: p.nameEn || '',
        options: (p.options || []).map((o) => ({
          name: o.name,
          nameEn: o.nameEn || '',
          price: Number(o.price) || 0,
        })),
      })),
  };
}

// The default selection for every group: the sheet's first option.
// Shape: { 'ขนาด': { name: 'ไซส์ M', price: 0 }, ... }
export function defaultChoices(groups) {
  const picked = {};
  for (const group of groups) {
    if (group.options?.length) picked[group.name] = group.options[0];
  }
  return picked;
}

// What the selected choices add to the dish price.
export function choicesCost(picked) {
  return Object.values(picked || {}).reduce((sum, o) => sum + (o?.price || 0), 0);
}
