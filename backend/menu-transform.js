// ---------------------------------------------------------------------------
// Menu row -> app shape transforms (source-agnostic)
// ---------------------------------------------------------------------------
// These pure functions map one-row-per-variant menu data onto the shape the
// app expects. They know nothing about WHERE the rows came from — the
// PostgreSQL bridge (menu-db.js) feeds them rows keyed by the same Thai column
// names the data was originally authored with.
//
//     { id, name, price, category, group, theme, emoji, image, desc,
//       options, available }
//
// One normalised row per sellable variant:
//
//   หมวดหมู่     อาหาร | เพิ่มเติม | ของหวาน | เครื่องดื่ม   -> food/drink group
//   ประเภท       เมนูหลัก (a dish) | รายการเสริม (an add-on)
//   หัวข้อ        เมนูราดข้าว, อาหารจานเดียว, ชา, กาแฟ ...   -> section heading
//   ชื่อรายการ    dish name
//   เนื้อสัตว์     protein for this row, or "-" -> becomes an `options` entry
//   ราคา (บาท)   price for this row
//   รูปภาพ       image URL (shared by every variant of a dish)
//
// Rows sharing (หัวข้อ + ชื่อรายการ) are merged into ONE dish whose `options`
// list carries the protein choices, e.g. ทอดน้ำปลาราดข้าว -> หมู/ไก่/หมูกรอบ/ทะเล.
// ---------------------------------------------------------------------------

// Column names, kept here so a schema rename is a one-line fix.
const COL = {
  group: 'หมวดหมู่',
  kind: 'ประเภท',
  heading: 'หัวข้อ',
  name: 'ชื่อรายการ',
  protein: 'เนื้อสัตว์',
  price: 'ราคา (บาท)',
  image: 'รูปภาพ',
  // English companions. Absent when the source has no translation column, in
  // which case text() yields '' and the app falls back to the Thai value.
  headingEn: 'หัวข้อ(en)',
  nameEn: 'ชื่อรายการ(en)',
  proteinEn: 'เนื้อสัตว์(en)',
};

const KIND_DISH = 'เมนูหลัก';       // a sellable dish
const KIND_ADDON = 'รายการเสริม';   // an optional extra, not a dish
const DRINK_GROUP = 'เครื่องดื่ม';   // หมวดหมู่ value that means "drink"

// รายการเสริม rows split by their หัวข้อ into two different controls:
//   CHOICE_HEADINGS -> pick exactly one (radio), e.g. ไซส์ M *or* ไซส์ L
//   everything else -> tick as many as you like (checkbox), e.g. ท็อปปิ้ง
const CHOICE_HEADINGS = ['ขนาด', 'ระดับความหวาน'];

// --- Cell helpers -----------------------------------------------------------

// Value -> usable number. Accepts a number (55) or a string ("55", "55 บาท",
// "-", ""). Returns `fallback` for anything that isn't a usable figure.
export function toNumber(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const raw = String(value ?? '').trim();
  if (!raw || raw === '-') return fallback;
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

// Cell -> trimmed string. "-" is the "not applicable" marker, so it reads as
// empty.
export function text(value) {
  const raw = String(value ?? '').trim();
  return raw === '-' ? '' : raw;
}

// --- Emoji fallback ---------------------------------------------------------

// Pick a fitting emoji from the dish name so the menu isn't a wall of 🍽️.
// Ordered most-specific first (protein/ingredient, then cooking style).
// Used only as a fallback for the rows with no รูปภาพ.
const EMOJI_RULES = [
  ['ทะเล', '🦐'], ['กุ้ง', '🍤'], ['หอย', '🐚'], ['ปู', '🦀'],
  ['ปลาดุก', '🐟'], ['ปลาเค็ม', '🐟'], ['ปลา', '🐟'],
  ['กบ', '🐸'], ['หมูป่า', '🐗'], ['หมูกรอบ', '🥓'], ['หมู', '🐷'],
  ['เนื้อ', '🥩'], ['ไก่', '🍗'], ['ไข่', '🍳'],
  ['ต้มข่า', '🥥'], ['ต้มจืด', '🍲'], ['ต้มโคล้ง', '🍲'], ['ต้ม', '🍲'],
  ['แกงส้ม', '🥘'], ['แกง', '🥘'], ['สะตอ', '🫛'],
  ['ข้าวผัด', '🍚'], ['ผัดซีอิ๊ว', '🍜'], ['ราดหน้า', '🍜'],
  ['กะเพรา', '🌿'], ['ผัด', '🍳'], ['ข้าว', '🍚'],
  // Drinks & sweets
  ['ไข่มุก', '🧋'], ['เฉาก๊วย', '🍮'], ['บุก', '🍮'], ['นม', '🥛'],
  ['โกโก้', '🍫'], ['เอสเปรสโซ่', '☕'], ['ลาเต้', '☕'], ['คาปูชิโน่', '☕'],
  ['มอคค่า', '☕'], ['อเมริกาโน่', '☕'], ['กาแฟ', '☕'],
  ['โซดา', '🥤'], ['ชา', '🍵'],
];

function emojiFor(name) {
  for (const [kw, emoji] of EMOJI_RULES) {
    if (name.includes(kw)) return emoji;
  }
  return '🍽️';
}

// The data is inconsistent about where the protein lives: เมนูราดข้าว rows keep
// the name clean ("ทอดน้ำปลาราดข้าว" + เนื้อสัตว์ "หมู"), while เมนูต้ม rows repeat
// it in the name ("ต้มจืดเต้าหู้ หมูสับ" + เนื้อสัตว์ "หมูสับ"). Strip the trailing
// protein so both conventions group into one dish.
function stripTrailingProtein(name, protein) {
  if (!protein || !name.endsWith(protein)) return name;
  const base = name.slice(0, -protein.length).trim();
  return base || name; // a dish named only after its protein keeps its name
}

// Which menu a row belongs to. The database's `theme` column decides; rows from
// a source that has no such column (or an un-migrated table) are daytime.
// 'none' is the owner's "hidden everywhere" state (both sun & moon off) and must
// pass through untouched — coercing it to 'day' would silently un-hide the dish.
function rowTheme(row) {
  const t = text(row?.theme);
  return t === 'night' || t === 'both' || t === 'none' ? t : 'day';
}

// The storefront(s) a row's theme puts it in. Used by the extras/choices
// builders, which file every row under one or both shifts.
function themesFor(theme) {
  if (theme === 'both') return ['day', 'night'];
  if (theme === 'none') return [];
  return [theme];
}

// Stable, readable id derived from the dish identity rather than row position,
// so an owner's `available` toggle survives rows being reordered.
//
// `theme` is part of the key because the two menus genuinely share dish names:
// ข้าวผัด appears under อาหารจานเดียว in both, at 50฿ by day and 70฿ by night.
// Without it they would collapse onto one id and overwrite each other.
function idFor(theme, heading, name) {
  let hash = 0;
  const key = `${theme}|${heading}|${name}`;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `d${hash.toString(36)}`;
}

// Is this row on sale? Rows from a table without the `available` column (or any
// other source) arrive with the field missing, which reads as "on sale" — the
// same default the column itself carries.
function rowAvailable(row) {
  return row?.available !== false;
}

// Group the raw rows into dishes WITHOUT dropping the source rows.
//
// This is the single definition of "which rows make up one dish", and both
// callers depend on it agreeing exactly:
//   * menuRowsToMenu() below, which builds the cards the app renders
//   * menu-db.js setDishAvailability(), which has to find the DB rows behind a
//     dish id in order to UPDATE them
//
// Matching those rows back by (theme, subcategory, name) instead would quietly
// fail for any dish with protein options: stripTrailingProtein() means the
// dish's app-level name ("ต้มจืดเต้าหู้") is not the name in any of its rows
// ("ต้มจืดเต้าหู้ หมูสับ"). Going through the same grouping avoids that.
export function groupDishRows(rows) {
  // Only real dishes. `รายการเสริม` rows are add-ons (ไข่ดาว, ท็อปปิ้ง, ขนาด,
  // ระดับความหวาน) and must not appear as cards in the menu.
  const dishRows = rows.filter((r) => text(r[COL.kind]) === KIND_DISH);

  // Pass 1 — bucket rows by (heading|name), preserving first-seen order.
  const groups = [];
  const byKey = new Map();
  for (const row of dishRows) {
    const rawName = text(row[COL.name]);
    if (!rawName) continue; // ignore rows with no dish name

    const protein = text(row[COL.protein]); // "" when the source says "-"
    const baseName = stripTrailingProtein(rawName, protein);
    const heading = text(row[COL.heading]);
    const theme = rowTheme(row);
    // Theme leads the key so the day and night versions of a shared dish name
    // stay two separate menu cards.
    const key = `${theme}|${heading}|${baseName}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        name: baseName,
        nameEn: text(row[COL.nameEn]),       // '' when no translation column
        heading,
        headingEn: text(row[COL.headingEn]),
        theme,
        group: text(row[COL.group]) === DRINK_GROUP ? 'drink' : 'food',
        image: text(row[COL.image]),
        rows: [],
      };
      byKey.set(key, g);
      groups.push(g);
    }
    if (!g.image) g.image = text(row[COL.image]); // first variant that has one
    g.rows.push({
      row,
      rawName,
      rawNameEn: text(row[COL.nameEn]),
      protein,
      proteinEn: text(row[COL.proteinEn]),
      price: toNumber(row[COL.price], 0),
    });
  }

  // Pass 2 — resolve each group's identity (id + display name + options).
  return groups.map((g) => {
    const variants = g.rows.filter((r) => r.protein);
    // 2+ protein variants -> a single dish with selectable options.
    const options = variants.length >= 2
      ? variants.map((r) => ({ name: r.protein, nameEn: r.proteinEn, price: r.price }))
      : [];
    const price = options.length
      ? Math.min(...options.map((o) => o.price)) // "starts at" price
      : toNumber(g.rows[0]?.price, 0);
    // With no choice to offer, the protein is part of the dish's identity —
    // keep the original wording ("ผัดเผ็ดราดข้าว หมู") rather than the stripped
    // base name.
    const name = options.length ? g.name : g.rows[0].rawName;
    // The English name never carries the protein (the sheet's translations are
    // of the base dish), so both cases take the group's English name.
    const nameEn = options.length ? g.nameEn : g.rows[0].rawNameEn;

    return {
      id: idFor(g.theme, g.heading, name),
      name,
      nameEn,
      price,
      options,
      baseName: g.name, // protein stripped; what the emoji fallback keys off
      heading: g.heading,
      headingEn: g.headingEn,
      theme: g.theme,
      group: g.group,
      image: g.image,
      // A dish is on sale while ANY of its rows is. Toggling from the owner tab
      // always writes every row of the dish at once, so the two agree; the
      // "any" rule only decides the case where someone flips a subset of rows
      // by hand in pgAdmin, and there it keeps the dish orderable rather than
      // hiding it because one protein went off.
      available: g.rows.some((r) => rowAvailable(r.row)),
      sourceRows: g.rows.map((r) => r.row),
    };
  });
}

// Map cleaned rows onto menu items.
export function menuRowsToMenu(rows) {
  return groupDishRows(rows).map((dish) => ({
    id: dish.id,
    name: dish.name,
    nameEn: dish.nameEn,                        // '' -> UI falls back to Thai
    price: dish.price,
    category: dish.heading || 'อื่นๆ',
    categoryEn: dish.headingEn,
    group: dish.group,
    theme: dish.theme, // from the `theme` column: 'day' or 'night'
    emoji: emojiFor(dish.baseName),
    image: dish.image,
    desc: '',
    options: dish.options,
    available: dish.available,
  }));
}

// Map the `รายการเสริม` rows onto the tick-box extras shown in the order
// dialog, split by which storefront they belong to:
//
//   food  — ไข่ดาว, ไข่เจียว, เป็นกับข้าว, สั่งกลับบ้าน
//   drink — ท็อปปิ้ง
//
// Rows whose หัวข้อ is a CHOICE_HEADING are handled by choiceRowsToChoices()
// instead: as tick-boxes they would let a customer order both ไซส์ M and
// ไซส์ L, or two sweetness levels at once.
//
// Both storefronts are built the same way — เรินเก่า (night) is not a special
// case with one undivided list any more. The result is scoped by shift so the
// two never borrow each other's extras:
//
//   { day:   { food: [...], drink: [...] },
//     night: { food: [...], drink: [...] } }
//
// A row marked 'both' lands in both shifts; 'none' is filed nowhere.
export function addonRowsToAddons(rows) {
  const addonRows = rows.filter((r) => text(r[COL.kind]) === KIND_ADDON);
  const out = { day: { food: [], drink: [] }, night: { food: [], drink: [] } };

  for (const row of addonRows) {
    const name = text(row[COL.name]);
    if (!name) continue;
    if (CHOICE_HEADINGS.includes(text(row[COL.heading]))) continue;

    const group = text(row[COL.group]) === DRINK_GROUP ? 'drink' : 'food';
    for (const theme of themesFor(rowTheme(row))) {
      const bucket = out[theme][group];
      // สั่งกลับบ้าน is listed under both อาหาร and เพิ่มเติม — keep it once.
      if (bucket.some((a) => a.name === name)) continue;
      bucket.push({
        id: idFor(theme, 'addon', name),
        name,
        nameEn: text(row[COL.nameEn]),
        price: toNumber(row[COL.price], 0),
      });
    }
  }
  return out;
}

// Map the pick-exactly-one รายการเสริม rows onto choice groups:
//
//   { name: 'ขนาด',           options: [ไซส์ M +0, ไซส์ L +5] }
//   { name: 'ระดับความหวาน',  options: [100%, 50%, 25%, 0%, 120%] }
//
// Row order is preserved and the FIRST option of each group is the default,
// which is why 100% (หวานปกติ) leading the sweetness rows matters.
//
// Scoped by shift exactly like the extras above. Night rows used to be dropped
// here because the night storefront showed no pick-one groups at all; it now
// runs the same rules as the day shop, so its ขนาด / ระดับความหวาน rows are
// built too.
export function choiceRowsToChoices(rows) {
  const addonRows = rows.filter((r) => text(r[COL.kind]) === KIND_ADDON);
  const out = { day: { food: [], drink: [] }, night: { food: [], drink: [] } };

  for (const row of addonRows) {
    const heading = text(row[COL.heading]);
    if (!CHOICE_HEADINGS.includes(heading)) continue;
    const name = text(row[COL.name]);
    if (!name) continue;

    const group = text(row[COL.group]) === DRINK_GROUP ? 'drink' : 'food';
    for (const theme of themesFor(rowTheme(row))) {
      const bucket = out[theme][group];
      let entry = bucket.find((g) => g.name === heading);
      if (!entry) {
        entry = {
          id: idFor(theme, 'choice', heading),
          name: heading,
          nameEn: text(row[COL.headingEn]),
          options: [],
        };
        bucket.push(entry);
      }
      if (entry.options.some((o) => o.name === name)) continue;
      entry.options.push({ name, nameEn: text(row[COL.nameEn]), price: toNumber(row[COL.price], 0) });
    }
  }

  // A group with one option is not a choice — hide it rather than show a radio
  // button that cannot be changed.
  for (const theme of ['day', 'night']) {
    for (const key of ['food', 'drink']) {
      out[theme][key] = out[theme][key].filter((g) => g.options.length >= 2);
    }
  }
  return out;
}
