-- ==========================================================
-- ตู้กับข้าวบ้านยาย — Stock (สต๊อกสินค้า) table
-- โครงสร้างตรงกับไฟล์ CSV: ประเภท, ชื่อรายการ, จำนวน, รูปภาพ
-- ==========================================================

-- 1) ตารางสต๊อก
CREATE TABLE IF NOT EXISTS stock_items (
    id         SERIAL PRIMARY KEY,          -- เลขอัตโนมัติ ไม่ต้องกรอก
    category   TEXT NOT NULL,               -- ประเภท (เครื่องดื่ม, ขนมขบเคี้ยว, ...)
    name       TEXT NOT NULL,               -- ชื่อรายการ
    quantity   INTEGER NOT NULL DEFAULT 0,  -- จำนวน (คงเหลือ)
    image_url  TEXT                          -- รูปภาพ (URL)
);

-- ==========================================================
-- 2) นำเข้า CSV  (รันได้เลยใน pgAdmin Query Tool)
--    เซิร์ฟเวอร์ต้องอ่านไฟล์นี้ได้ — Postgres.app รันในชื่อผู้ใช้ของคุณ
--    จึงอ่านไฟล์ใน ~/Downloads ได้ ถ้าเจอ error "Permission denied"
--    หรือ "could not open file" ให้ใช้ \copy ใน psql แทน (ดูในแชท)
-- ==========================================================
COPY stock_items (category, name, quantity, image_url)
FROM '/Users/punnawit/Downloads/Copy of ตู้กับข้าวบ้านยาย Menu - stock.csv'
WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

-- ==========================================================
-- 3) ทำความสะอาดหลังนำเข้า (ถ้าต้องการ)
-- ==========================================================
UPDATE stock_items SET image_url = NULL WHERE image_url = '';

-- ==========================================================
-- 4) ตรวจสอบ
-- ==========================================================
-- SELECT COUNT(*) FROM stock_items;                      -- ควรได้ 54
-- SELECT * FROM stock_items ORDER BY id LIMIT 20;
-- SELECT DISTINCT category FROM stock_items;             -- ดูประเภททั้งหมด
-- SELECT category, SUM(quantity) FROM stock_items GROUP BY category;
