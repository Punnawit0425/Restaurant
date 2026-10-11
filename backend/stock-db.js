// ---------------------------------------------------------------------------
// PostgreSQL -> stock (คลังวัตถุดิบ) bridge
// ---------------------------------------------------------------------------
// Reads the staff inventory straight from the `stock_items` table (created and
// loaded from the CSV via stock_schema.sql). Columns: id, category, name,
// quantity, image_url.
//
// This is deliberately separate from the in-memory `stock` used to validate and
// deduct drink stock while taking an order — that path is untouched. This module
// backs only the "คลังวัตถุดิบ" tab in the staff view.
//
// Connection string comes from backend/.env (DATABASE_URL).
// ---------------------------------------------------------------------------

import { getPool } from './db.js';

// The whole inventory, newest categories grouped together, then by name (Thai
// collation so the list reads naturally).
export async function fetchStockItems() {
  const { rows } = await getPool().query(`
    SELECT id, category, name, quantity, image_url AS "imageUrl"
    FROM stock_items
    ORDER BY category, name
  `);
  return rows;
}

// Just the names and remaining quantities — the customer storefront reads this
// (no auth) so it can grey out a dish whose linked stock has run out. Kept
// deliberately minimal: no ids, images or categories leak to the public.
export async function fetchStockAvailability() {
  const { rows } = await getPool().query(`
    SELECT name, quantity FROM stock_items
  `);
  return rows;
}

// Create a new inventory row, or — if one with the same name already exists —
// top it up by `quantity`. This is what the owner's "อัพเดทสตอก" action calls
// when it files a dish and its stock together: matching by name keeps a single
// row per product and lets the customer storefront link the two automatically.
export async function createStockItem({ category, name, quantity, imageUrl }) {
  const pool = getPool();
  const updated = await pool.query(
    `UPDATE stock_items
     SET quantity  = quantity + $2,
         category  = COALESCE(NULLIF($3, ''), category),
         image_url = COALESCE(NULLIF($4, ''), image_url)
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
     RETURNING id, category, name, quantity, image_url AS "imageUrl"`,
    [name, quantity, category, imageUrl || null]
  );
  if (updated.rows[0]) return updated.rows[0];

  const inserted = await pool.query(
    `INSERT INTO stock_items (category, name, quantity, image_url)
     VALUES ($1, $2, $3, $4)
     RETURNING id, category, name, quantity, image_url AS "imageUrl"`,
    [category, name, quantity, imageUrl || null]
  );
  return inserted.rows[0];
}

// Deduct `qty` from the row whose name matches the dish (or restore it when
// `qty` is negative — un-serving a mis-tap). Same LOWER(TRIM(...)) match as
// createStockItem, so the dish↔stock link stays name-based end to end. Never
// below 0 — `quantityBefore` comes back alongside the row so the caller can log
// what actually moved, not what was asked for. Returns { item, duplicate }:
// `item` is null when no row matches (a dish with no linked stock is a no-op).
//
// `opKey` makes the cut safe to retry. A tablet that lost its connection mid-cut
// cannot tell whether the server applied it, so it sends the same key again; the
// key is recorded in the same transaction as the cut, so a key already on file
// means the cut already happened and it is not applied twice (`duplicate`).
export async function consumeStockByName(name, qty, opKey = null) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (opKey) {
      const { rowCount } = await client.query(
        `INSERT INTO stock_ops (op_key) VALUES ($1) ON CONFLICT DO NOTHING`,
        [opKey]
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        const { rows } = await client.query(
          `SELECT id, category, name, quantity, image_url AS "imageUrl"
           FROM stock_items WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))`,
          [name]
        );
        return { item: rows[0] || null, duplicate: true };
      }
    }
    const { rows } = await client.query(
      `WITH old AS (
         SELECT id, quantity FROM stock_items
         WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
         FOR UPDATE
       )
       UPDATE stock_items s
       SET quantity = GREATEST(0, s.quantity - $2)
       FROM old
       WHERE s.id = old.id
       RETURNING s.id, s.category, s.name, s.quantity, s.image_url AS "imageUrl",
                 old.quantity AS "quantityBefore"`,
      [name, qty]
    );
    await client.query('COMMIT');
    return { item: rows[0] || null, duplicate: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Add `delta` (may be negative) to one item's quantity, never dropping below 0.
// Returns the updated row with `quantityBefore`, or null if the id matched
// nothing.
export async function adjustStockItem(id, delta) {
  const { rows } = await getPool().query(
    `WITH old AS (SELECT id, quantity FROM stock_items WHERE id = $1 FOR UPDATE)
     UPDATE stock_items s
     SET quantity = GREATEST(0, s.quantity + $2)
     FROM old
     WHERE s.id = old.id
     RETURNING s.id, s.category, s.name, s.quantity, s.image_url AS "imageUrl",
               old.quantity AS "quantityBefore"`,
    [id, delta]
  );
  return rows[0] || null;
}

// Replace one item's photo (image_url), leaving its count untouched. Called when
// the owner changes a dish's picture from the menu screen so the linked คลัง row
// keeps the same image — the two are matched by name everywhere else, so their
// pictures should never drift apart. An empty string clears the photo. Returns
// the updated row, or null if the id matched nothing.
export async function setStockItemImage(id, imageUrl) {
  const { rows } = await getPool().query(
    `UPDATE stock_items
     SET image_url = $2
     WHERE id = $1
     RETURNING id, category, name, quantity, image_url AS "imageUrl"`,
    [id, imageUrl || null]
  );
  return rows[0] || null;
}

// Same, but found the way every other dish↔stock link is found: by name, under
// LOWER(TRIM(...)).
//
// The owner's browser used to locate the row itself and PATCH it by id, using a
// plain `===` on the name. That is a stricter rule than the database's, so a
// คลัง row imported with a trailing space or a different case simply never
// matched — the picture was changed on the menu and silently not on the คลัง
// row, with nothing on screen to say so. Matching here, with the same rule as
// consumeStockByName, is what makes the two agree.
//
// Returns the updated row, or null when no row carries that name.
export async function setStockImageByName(name, imageUrl) {
  const { rows } = await getPool().query(
    `UPDATE stock_items
     SET image_url = $2
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
     RETURNING id, category, name, quantity, image_url AS "imageUrl"`,
    [name, imageUrl || null]
  );
  return rows[0] || null;
}

// Remove the คลัง row belonging to a deleted dish, matched by the same
// LOWER(TRIM(name)) rule. Returns the row that was removed, or null when the
// dish had no stock row (most dishes don't — only the stocked drinks and
// packaged items do).
export async function deleteStockItemByName(name) {
  const { rows } = await getPool().query(
    `DELETE FROM stock_items
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
     RETURNING id, category, name, quantity, image_url AS "imageUrl"`,
    [name]
  );
  return rows[0] || null;
}

// Remove one คลัง row by its id — the owner clearing out a row that no longer
// belongs there. Returns the removed row, or null if the id matched nothing.
export async function deleteStockItem(id) {
  const { rows } = await getPool().query(
    `DELETE FROM stock_items
     WHERE id = $1
     RETURNING id, category, name, quantity, image_url AS "imageUrl"`,
    [id]
  );
  return rows[0] || null;
}

// Bump every item by `delta` (the "เติมทั้งหมด" buttons). Returns how many rows
// changed, and how many of those hit the 0 floor and so moved by less than
// `delta` (only possible when `delta` is negative).
export async function restockAll(delta) {
  const { rows } = await getPool().query(
    `WITH old AS (SELECT id, quantity FROM stock_items FOR UPDATE)
     UPDATE stock_items s
     SET quantity = GREATEST(0, s.quantity + $1)
     FROM old
     WHERE s.id = old.id
     RETURNING s.quantity - old.quantity AS moved`,
    [delta]
  );
  return {
    changed: rows.length,
    clamped: rows.filter((r) => Number(r.moved) !== Number(delta)).length,
  };
}

// ---------------------------------------------------------------------------
// Stock history (ประวัติการบันทึกสต็อก)
// ---------------------------------------------------------------------------
// An append-only audit trail of every stock movement — who changed what, by how
// much, and the resulting on-hand count. Written from the server endpoints (they
// know the logged-in user); read by the "ประวัติ" panel in the คลังวัตถุดิบ tab.
// Logging is best-effort: a failed insert must never block the actual stock
// change, so callers fire-and-forget and swallow errors.

// Create the table on first run so a fresh clone works without pasting SQL.
export async function ensureStockHistoryTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS stock_history (
      id             BIGSERIAL PRIMARY KEY,
      item_id        INTEGER,
      item_name      TEXT,
      category       TEXT,
      action         TEXT NOT NULL,
      delta          INTEGER NOT NULL DEFAULT 0,
      quantity_after INTEGER,
      note           TEXT,
      by_user        TEXT,
      by_name        TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // `note` was added after the first release — backfill it on existing tables.
  await getPool().query(`ALTER TABLE stock_history ADD COLUMN IF NOT EXISTS note TEXT`);
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS stock_history_created_at_idx ON stock_history (created_at DESC)`
  );
  // Keys of stock cuts already applied — see consumeStockByName. A retry only
  // ever arrives within minutes (at most days, for a tablet left offline), so
  // old keys are pruned on start-up.
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS stock_ops (
      op_key     TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await getPool().query(`DELETE FROM stock_ops WHERE created_at < now() - interval '30 days'`);
}

// Append one entry. `delta` is the signed change in on-hand count (+ added,
// − removed); `quantityAfter` is the resulting count (null for aggregate rows
// like เติมทั้งหมด where there is no single number).
export async function logStockChange({
  itemId = null, itemName = null, category = null, action,
  delta = 0, quantityAfter = null, note = null, byUser = null, byName = null,
}) {
  const { rows } = await getPool().query(
    `INSERT INTO stock_history
       (item_id, item_name, category, action, delta, quantity_after, note, by_user, by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [itemId, itemName, category, action, delta, quantityAfter, note, byUser, byName]
  );
  return rows[0];
}

// Most recent movements first. `limit` is capped by the caller.
export async function fetchStockHistory(limit = 200, date = null) {
  // `date` ('YYYY-MM-DD') narrows the log to one WORKING day: 06:00 that date →
  // 06:00 the next, Bangkok time — the same day every other date in the app is
  // keyed on (workdayKey in frontend/src/shift.js), so a movement at 01:00 lands
  // on the night that made it. Omitted = the latest rows across all days.
  const { rows } = await getPool().query(
    `SELECT id, item_id AS "itemId", item_name AS "itemName", category, action,
            delta, quantity_after AS "quantityAfter", note,
            by_user AS "byUser", by_name AS "byName", created_at AS "createdAt"
     FROM stock_history
     WHERE $2::date IS NULL
        OR (created_at >= ($2::date + time '06:00') AT TIME ZONE 'Asia/Bangkok'
            AND created_at < ($2::date + 1 + time '06:00') AT TIME ZONE 'Asia/Bangkok')
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit, date]
  );
  return rows;
}
