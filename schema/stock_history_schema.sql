-- ---------------------------------------------------------------------------
-- stock_history — audit trail for every stock movement (ประวัติการบันทึกสต็อก)
-- ---------------------------------------------------------------------------
-- Append-only log of who changed the คลังวัตถุดิบ, by how much, and when.
-- Written by the /api/stock-items/* endpoints (they know the logged-in user);
-- read by the "ประวัติ" panel in the staff คลังวัตถุดิบ tab.
--
-- The server creates this table automatically on first run
-- (ensureStockHistoryTable in backend/stock-db.js), so running this file by
-- hand is optional — it just documents the same shape.
--
--   action values:
--     'adjust'       one item's +/- from the คลังวัตถุดิบ tab
--     'restock-all'  the "เติมทั้งหมด" bulk buttons (aggregate row, no item_id)
--     'create'       owner added / topped up an item via "อัพเดทสตอก"
--     'serve'        stock deducted when a dish was marked เสิร์ฟแล้ว
--     'unserve'      stock restored when a serve was undone
--
--   delta          signed change in on-hand count (+ added, - removed)
--   quantity_after resulting count (NULL for aggregate 'restock-all' rows)
--   note           reason for a removal (e.g. เจ้าของดื่มเอง), when given
-- ---------------------------------------------------------------------------

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
);

CREATE INDEX IF NOT EXISTS stock_history_created_at_idx ON stock_history (created_at DESC);
