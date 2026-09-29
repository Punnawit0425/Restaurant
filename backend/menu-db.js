// ---------------------------------------------------------------------------
// PostgreSQL -> menu bridge
// ---------------------------------------------------------------------------
// The menu's single source of truth: reads one-row-per-variant data from a
// Postgres `menu_items` table and runs it through the shared transforms in
// menu-transform.js, producing the { menu, addons, choices } shape the app
// expects.
//
// The table is created/loaded from the CSV via menu_schema.sql. Its English
// columns are aliased back to the Thai column names the transforms expect, so
// no mapping logic has to be duplicated here.
//
// Connection string comes from backend/.env (DATABASE_URL), e.g.
//   DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/restaurant
// ---------------------------------------------------------------------------

import { getPool } from './db.js';
import {
  menuRowsToMenu,
  addonRowsToAddons,
  choiceRowsToChoices,
  groupDishRows,
  text,
  toNumber,
} from './menu-transform.js';

// Read menu_items and hand back rows keyed by the Thai column names, so the
// shared transforms in menu-transform.js can consume them unchanged.
// Does menu_items carry the day/night `theme` column yet? A table created
// before the night menu existed does not, so it is detected once rather than
// assumed — that way starting the server before running the ALTER prints a hint
// instead of crashing with a bare "column does not exist".
// Both optional columns are probed the same way and the answer cached, so the
// check costs one query per column for the life of the process.
const columnCache = new Map();
const MISSING_COLUMN_HINT = {
  theme:
    'menu_items has no "theme" column — treating every item as the DAY menu. ' +
    'Add it with:  ALTER TABLE menu_items ADD COLUMN theme TEXT;',
  available:
    'menu_items has no "available" column — every dish will show as on sale ' +
    'and the owner\'s on/off switch cannot be saved. Add it with:  ' +
    'ALTER TABLE menu_items ADD COLUMN available BOOLEAN NOT NULL DEFAULT true;',
  sort_order:
    'menu_items has no "sort_order" column — dishes fall back to insertion ' +
    'order and the owner cannot rearrange the customer menu. Add it with:  ' +
    'ALTER TABLE menu_items ADD COLUMN sort_order INTEGER;',
};

async function hasColumn(name) {
  if (!columnCache.has(name)) {
    const { rows } = await getPool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'menu_items' AND column_name = $1
       LIMIT 1`,
      [name]
    );
    const present = rows.length > 0;
    columnCache.set(name, present);
    if (!present) console.warn(`[backend] ${MISSING_COLUMN_HINT[name] || `menu_items has no "${name}" column`}`);
  }
  return columnCache.get(name);
}

// Does the table carry the on/off switch yet? server.js asks so it knows
// whether the database or the old in-memory state owns `available`.
export function hasAvailableColumn() {
  return hasColumn('available');
}

async function fetchMenuRows() {
  // `theme` and `available` keep their English names: they are database
  // concepts, not columns that ever existed in the spreadsheet the Thai aliases
  // mirror. The primary key rides along as `__rowId` so a dish can be traced
  // back to the exact rows to UPDATE.
  const themeSelect = (await hasColumn('theme'))
    ? `COALESCE(theme, 'day') AS theme`
    : `'day' AS theme`;
  const availableSelect = (await hasColumn('available'))
    ? `COALESCE(available, true) AS available`
    : `true AS available`;
  // English companions are optional: a table without them selects '' so the
  // transforms (and the app) simply fall back to the Thai text.
  const subEnSelect = (await hasColumn('subcategory_en'))
    ? `COALESCE(subcategory_en, '')` : `''`;
  const nameEnSelect = (await hasColumn('name_en'))
    ? `COALESCE(name_en, '')` : `''`;
  const meatEnSelect = (await hasColumn('meat_en'))
    ? `COALESCE(meat_en, '')` : `''`;

  // The owner's hand-set order. It rides along as `__sortOrder` (like __rowId,
  // an internal field the transforms ignore) purely so an edit can put the dish
  // back in the same place — see updateMenuItem, which deletes and re-inserts.
  const hasSort = await hasColumn('sort_order');
  const sortSelect = hasSort ? 'sort_order' : 'NULL::int';
  // Rows the owner has never arranged (sort_order NULL) sort after the ones they
  // have, newest-dish-last, rather than jumping to the top of the menu. Ordering
  // by id second keeps a dish's protein rows together and in their entered
  // order, which is what makes the first option the default.
  const orderBy = hasSort
    ? 'ORDER BY COALESCE(sort_order, 2147483647), id'
    : 'ORDER BY id';

  const { rows } = await getPool().query(`
    SELECT id          AS "__rowId",
           category    AS "หมวดหมู่",
           type        AS "ประเภท",
           subcategory AS "หัวข้อ",
           name        AS "ชื่อรายการ",
           meat        AS "เนื้อสัตว์",
           price       AS "ราคา (บาท)",
           image_url   AS "รูปภาพ",
           ${subEnSelect}  AS "หัวข้อ(en)",
           ${nameEnSelect} AS "ชื่อรายการ(en)",
           ${meatEnSelect} AS "เนื้อสัตว์(en)",
           ${themeSelect},
           ${availableSelect},
           ${sortSelect} AS "__sortOrder"
    FROM menu_items
    ${orderBy}
  `);
  return rows;
}

// Fetch from Postgres and build the menu + extras.
// Throws on connection/query errors so the caller can fall back to the
// last-known menu, exactly like the sheet path does.
export async function fetchMenuFromDb() {
  const rows = await fetchMenuRows();
  if (!rows.length) {
    throw new Error(
      'Table "menu_items" is empty. Import the CSV (see menu_schema.sql) first.'
    );
  }

  const menu = menuRowsToMenu(rows);
  if (!menu.length) {
    throw new Error(
      `menu_items has ${rows.length} rows but produced no dishes — ` +
      `check the "ประเภท"/"ชื่อรายการ" columns still hold the expected values.`
    );
  }

  return {
    menu,
    addons: addonRowsToAddons(rows),
    choices: choiceRowsToChoices(rows),
  };
}

// --- Writes -----------------------------------------------------------------

// The distinct values already in the table, for the owner's dropdowns. Read
// from the data rather than hard-coded, so a category added here shows up in
// the form without a code change.
export async function fetchMenuOptions() {
  const { rows } = await getPool().query(`
    SELECT DISTINCT category, type, subcategory FROM menu_items
  `);
  const clean = (v) => (v || '').trim();
  const collect = (key) =>
    [...new Set(rows.map((r) => clean(r[key])).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'th'));

  // The (หมวดหมู่, หัวข้อ) pairs that actually exist. A หัวข้อ is not free-standing —
  // "ชา" only ever belongs under เครื่องดื่ม — so the form needs the pairing to
  // stop a drink heading being offered on a food dish (which would then sort into
  // the wrong storefront section). Rows with no หัวข้อ contribute nothing here.
  // Re-deduped after trimming, since SELECT DISTINCT ran on the untrimmed values.
  const pairs = [
    ...new Map(
      rows
        .map((r) => ({ category: clean(r.category), subcategory: clean(r.subcategory) }))
        .filter((p) => p.category && p.subcategory)
        // Keyed on both halves together, so a pair is deduped as a pair.
        .map((p) => [`${p.category}\u0000${p.subcategory}`, p])
    ).values(),
  ];

  return {
    categories: collect('category'),
    types: collect('type'),
    subcategories: collect('subcategory'),
    pairs,
  };
}

// Flip one dish on or off. A dish is several rows (one per protein), so this
// updates every row behind it — found by running the live rows through the same
// grouping the menu itself is built from, never by re-matching on name.
// Returns the number of rows updated; 0 means the id matched no dish.
export async function setDishAvailability(dishId, available) {
  if (!(await hasColumn('available'))) {
    throw new Error(
      'menu_items has no "available" column — run: ALTER TABLE menu_items ' +
      'ADD COLUMN available BOOLEAN NOT NULL DEFAULT true;'
    );
  }
  const dish = groupDishRows(await fetchMenuRows()).find((d) => d.id === dishId);
  if (!dish) return 0;

  const rowIds = dish.sourceRows.map((r) => r.__rowId).filter((id) => id != null);
  if (!rowIds.length) return 0;

  const { rowCount } = await getPool().query(
    `UPDATE menu_items SET available = $1 WHERE id = ANY($2::int[])`,
    [available, rowIds]
  );
  return rowCount;
}

// Set which shift(s) a dish appears in — 'day' | 'night' | 'both' | 'none'.
// 'none' is the "hidden everywhere" state: the customer menu filters on
// `theme === shift || theme === 'both'`, so a theme of 'none' matches no shift
// and the dish drops out of both storefronts without being deleted. Whenever a
// dish is put back on a real shift we also flip `available` back to true, so the
// sun/moon pill is the single control the owner needs (no stale ปิดขาย state).
// Like setDishAvailability, this rewrites every protein row behind the dish.
export async function setDishTheme(dishId, theme) {
  if (!(await hasColumn('theme'))) {
    throw new Error(
      'menu_items has no "theme" column — run: ALTER TABLE menu_items ' +
      'ADD COLUMN theme TEXT;'
    );
  }
  const dish = groupDishRows(await fetchMenuRows()).find((d) => d.id === dishId);
  if (!dish) return 0;

  const rowIds = dish.sourceRows.map((r) => r.__rowId).filter((id) => id != null);
  if (!rowIds.length) return 0;

  // Re-enabling a shift clears any leftover ปิดขาย flag so the dish actually
  // shows; hiding it (none) leaves `available` untouched.
  const alsoAvailable = theme !== 'none' && (await hasColumn('available'));
  const { rowCount } = await getPool().query(
    alsoAvailable
      ? `UPDATE menu_items SET theme = $1, available = true WHERE id = ANY($2::int[])`
      : `UPDATE menu_items SET theme = $1 WHERE id = ANY($2::int[])`,
    [theme, rowIds]
  );
  return rowCount;
}

// Make sure the table can hold a hand-set order, adding the column if it is not
// there yet. Unlike `theme` and `available` — which change what the app shows
// and so are left to a deliberate ALTER — this one is purely additive: a NULL
// sort_order means "not arranged yet", which is exactly how the menu already
// behaves. Called once at startup; a database user without ALTER rights just
// gets the warning and the SQL to run by hand, and the menu keeps working in
// insertion order.
export async function ensureMenuOrderColumn() {
  try {
    await getPool().query(`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
    columnCache.set('sort_order', true);
    return true;
  } catch (err) {
    console.warn(
      `[backend] Could not add menu_items.sort_order (${err.message}) — ` +
      'the owner cannot rearrange the menu until it exists. Run:  ' +
      'ALTER TABLE menu_items ADD COLUMN sort_order INTEGER;'
    );
    return false;
  }
}

// Rearrange the menu. `orderedIds` is the dish ids in the order the owner
// dragged them into; each dish's position is stamped onto every one of its rows,
// so the ORDER BY in fetchMenuRows reproduces exactly that sequence and the
// customer menu (which renders the array as it arrives, and takes its section
// order from where each heading first appears) follows along.
//
// The whole menu is renumbered from 0 on every save rather than only the moved
// dish: positions then stay dense and gap-free, so no amount of dragging can run
// two dishes onto the same number and leave the tie broken by row id.
//
// Ids the client did not send — a dish added from another tab mid-drag — are not
// dropped: they keep their current relative order at the end of the list.
// Returns the number of rows renumbered.
export async function setDishOrder(orderedIds) {
  if (!(await hasColumn('sort_order'))) {
    throw new Error(
      'menu_items has no "sort_order" column — run: ALTER TABLE menu_items ' +
      'ADD COLUMN sort_order INTEGER;'
    );
  }
  const dishes = groupDishRows(await fetchMenuRows());
  const byId = new Map(dishes.map((d) => [d.id, d]));

  const seen = new Set();
  const sequence = [];
  for (const id of orderedIds) {
    if (byId.has(id) && !seen.has(id)) { seen.add(id); sequence.push(id); }
  }
  for (const d of dishes) {
    if (!seen.has(d.id)) sequence.push(d.id);
  }

  // Flattened (row id -> position) pairs, one entry per protein row.
  const rowIds = [];
  const positions = [];
  sequence.forEach((id, position) => {
    for (const row of byId.get(id).sourceRows) {
      if (row.__rowId != null) { rowIds.push(row.__rowId); positions.push(position); }
    }
  });
  if (!rowIds.length) return 0;

  // One statement for the whole menu: 130-odd single-row UPDATEs would be 130
  // round trips, and a partial failure would leave the order half-applied.
  const { rowCount } = await getPool().query(
    `UPDATE menu_items AS m
        SET sort_order = v.position
       FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::int[]) AS position) AS v
      WHERE m.id = v.id`,
    [rowIds, positions]
  );
  return rowCount;
}

// Which of the optional English companion columns this table actually has.
// A menu_items imported before they existed has none, and the app then falls
// back to the Thai text everywhere.
async function englishColumns() {
  const [name, sub, meat] = await Promise.all([
    hasColumn('name_en'),
    hasColumn('subcategory_en'),
    hasColumn('meat_en'),
  ]);
  return { name, sub, meat };
}

// Compose the INSERT for one variant row out of whichever optional columns
// exist. Both writers go through this — without it an edit DELETEs the dish's
// rows and re-inserts them with no translations, silently wiping the ENG menu
// every time the owner touched a dish for any reason at all.
//
// `available` is null when the table has no such column; anything else is
// written through as the dish's carried-over on/off state. `sortOrder` works the
// same way, with one extra case: a brand-new dish passes null because it has no
// place yet, and a NULL sort_order is exactly what puts it at the end of the
// menu (see the ORDER BY in fetchMenuRows).
function menuInsert(spec, v, en, available, sortOrder = null) {
  const cols = ['category', 'type', 'subcategory', 'name', 'meat', 'price', 'image_url', 'theme'];
  const values = [
    spec.category, spec.type, spec.subcategory, spec.name,
    v.meat, v.price, spec.imageUrl || null, spec.theme,
  ];
  // Empty string -> NULL: an untranslated field must read as "no translation"
  // (so the app falls back to Thai), not as a blank English name.
  const push = (col, val) => { cols.push(col); values.push(val || null); };
  if (en.sub) push('subcategory_en', spec.subcategoryEn);
  if (en.name) push('name_en', spec.nameEn);
  if (en.meat) push('meat_en', v.meatEn);
  if (available !== null) { cols.push('available'); values.push(available); }
  if (sortOrder !== null) { cols.push('sort_order'); values.push(sortOrder); }

  const params = values.map((_, i) => `$${i + 1}`).join(', ');
  return {
    sql: `INSERT INTO menu_items (${cols.join(', ')}) VALUES (${params})`,
    values,
  };
}

// Add a dish: one row per protein option, all sharing the same image.
// `variants` is [{ meat, price }]; a dish with no protein choice passes a
// single variant with meat '-' , matching how the imported data spells "none".
//
// The rows go in inside a transaction so a dish is never left half-inserted
// (which would surface as a dish missing some of its options).
export async function insertMenuItem(spec) {
  if (!(await hasColumn('theme'))) {
    throw new Error(
      'menu_items has no "theme" column — a new dish could not be filed under ' +
      'the day or night menu. Run: ALTER TABLE menu_items ADD COLUMN theme TEXT;'
    );
  }
  const { variants } = spec;
  const en = await englishColumns();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of variants) {
      const { sql, values } = menuInsert(spec, v, en, null);
      await client.query(sql, values);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return variants.length;
}

// Read one dish back in the exact shape the owner's form edits: หมวดหมู่ /
// ประเภท / หัวข้อ come straight off the source rows (the app-facing menu drops
// them), the protein rows become variants, and a dish with none reports a single
// `price`. Returns null when the id matches no dish.
export async function getDishForEdit(dishId) {
  const dish = groupDishRows(await fetchMenuRows()).find((d) => d.id === dishId);
  if (!dish) return null;

  const first = dish.sourceRows[0] || {};
  // Only rows carrying a real protein are offered as variants; a "-" row is the
  // dish's own single price, matching how the create form treats them.
  const variants = dish.sourceRows
    .filter((r) => text(r['เนื้อสัตว์']))
    .map((r) => ({
      meat: r['เนื้อสัตว์'],
      meatEn: text(r['เนื้อสัตว์(en)']),
      price: toNumber(r['ราคา (บาท)'], 0),
    }));

  // The English companions travel with the dish. They have to: updateMenuItem
  // rewrites the dish's rows from this spec, so anything the form does not send
  // back is gone. One English name per dish, read off the first row — the same
  // normalisation the Thai `name` already gets.
  return {
    id: dish.id,
    category: first['หมวดหมู่'] || '',
    type: first['ประเภท'] || '',
    subcategory: first['หัวข้อ'] || '',
    subcategoryEn: text(first['หัวข้อ(en)']),
    name: dish.name,
    nameEn: text(dish.nameEn) || text(first['ชื่อรายการ(en)']),
    theme: dish.theme,
    imageUrl: dish.image || '',
    price: variants.length ? null : toNumber(first['ราคา (บาท)'], 0),
    variants,
  };
}

// Edit an existing dish. A dish is several rows and an edit can add, drop or
// rename its protein options, so rather than diff the two sets the old rows are
// deleted and the new spec is inserted fresh — all inside one transaction so the
// dish is never left half-rewritten. The on/off state is carried over from the
// old rows (an edit is not a re-list), so a dish that was ปิดขาย stays that way.
// Returns the number of rows written, or 0 if the id matched no dish.
export async function updateMenuItem(dishId, spec) {
  const { variants } = spec;
  if (!(await hasColumn('theme'))) {
    throw new Error(
      'menu_items has no "theme" column — the dish could not be re-filed under ' +
      'the day or night menu. Run: ALTER TABLE menu_items ADD COLUMN theme TEXT;'
    );
  }
  const dish = groupDishRows(await fetchMenuRows()).find((d) => d.id === dishId);
  if (!dish) return 0;
  const rowIds = dish.sourceRows.map((r) => r.__rowId).filter((id) => id != null);

  // Preserve the current on/off state, but only if the column exists to hold it.
  const keepAvailable = (await hasColumn('available')) ? dish.available : null;
  // Same for the owner's hand-set position: the rows are deleted and re-inserted,
  // so without carrying it over every edit — a price fix, a new photo — would
  // silently drop the dish to the bottom of the customer menu.
  const keepSortOrder = dish.sourceRows[0]?.__sortOrder ?? null;
  const en = await englishColumns();

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (rowIds.length) {
      await client.query(`DELETE FROM menu_items WHERE id = ANY($1::int[])`, [rowIds]);
    }
    for (const v of variants) {
      const { sql, values } = menuInsert(spec, v, en, keepAvailable, keepSortOrder);
      await client.query(sql, values);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return variants.length;
}

// Delete a dish for good. Like every other write here, a dish is several rows
// (one per protein option), so all of them go together — found through the same
// grouping the menu is built from rather than by re-matching on name, or a
// rename would leave orphaned rows behind. Returns the number of rows removed;
// 0 means the id matched no dish.
//
// Nothing else in the database points at a menu row: past orders store the dish
// name and price as text, so deleting a dish never rewrites history. The คลัง
// row of the same name (drinks / stocked items) is left alone — it is the
// stockroom's own record, and the owner clears it from คลังวัตถุดิบ.
export async function deleteMenuItem(dishId) {
  const dish = groupDishRows(await fetchMenuRows()).find((d) => d.id === dishId);
  if (!dish) return 0;
  const rowIds = dish.sourceRows.map((r) => r.__rowId).filter((id) => id != null);
  if (!rowIds.length) return 0;

  const { rowCount } = await getPool().query(
    `DELETE FROM menu_items WHERE id = ANY($1::int[])`,
    [rowIds]
  );
  return rowCount;
}

// Would this dish collide with one that already exists?
//
// The app's dish id is a hash of (theme|หัวข้อ|ชื่อ), so a second dish resolving
// to the same identity would share an id with the first: the two would collide
// in the menu and the on/off switch would flip both at once.
//
// Rather than re-deriving that identity here (and drifting from it the next
// time the grouping rules change), the prospective rows are run through the
// real grouping alongside the live ones. If they merge into an existing dish
// instead of forming a new one, the dish count does not grow — that is the
// collision, and it catches the cases a plain name comparison misses, e.g. a
// new "ต้มจืดเต้าหู้ หมูสับ" folding into the existing "ต้มจืดเต้าหู้".
// `excludeDishId` lets an edit ignore the dish's own rows, so re-saving a dish
// with its name unchanged is not flagged as colliding with itself.
export async function dishIdentityTaken({ category, type, subcategory, name, theme, variants }, excludeDishId = null) {
  const allRows = await fetchMenuRows();
  let existing = allRows;
  if (excludeDishId) {
    const self = groupDishRows(allRows).find((d) => d.id === excludeDishId);
    const selfIds = new Set((self?.sourceRows || []).map((r) => r.__rowId));
    existing = allRows.filter((r) => !selfIds.has(r.__rowId));
  }
  const candidateRows = variants.map((v) => ({
    'หมวดหมู่': category,
    'ประเภท': type,
    'หัวข้อ': subcategory,
    'ชื่อรายการ': name,
    'เนื้อสัตว์': v.meat,
    'ราคา (บาท)': v.price,
    'รูปภาพ': null,
    theme,
    available: true,
  }));
  // Add-on rows (รายการเสริม) are not dishes and never reach the grouping, so
  // "the count did not grow" would be true for reasons that have nothing to do
  // with a collision. Nothing to check for those.
  if (!groupDishRows(candidateRows).length) return false;

  const before = groupDishRows(existing).length;
  const after = groupDishRows([...existing, ...candidateRows]).length;
  return after === before;
}
