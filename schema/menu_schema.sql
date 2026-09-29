-- ==========================================================
-- ตู้กับข้าวบ้านยาย — Menu database schema
-- Run this in pgAdmin Query Tool (one step at a time or all together)
-- ==========================================================

-- 1) The table that mirrors your Google Sheet
CREATE TABLE menu_items (
    id             SERIAL PRIMARY KEY,          -- auto number, you don't fill this
    category       TEXT NOT NULL,               -- หมวดหมู่  (อาหาร, เครื่องดื่ม, ...)
    type           TEXT NOT NULL,               -- ประเภท   (เมนูหลัก, รายการเสริม)
    subcategory    TEXT,                        -- หัวข้อ   (เมนูราดข้าว, ชา, ...)
    name           TEXT NOT NULL,               -- ชื่อรายการ
    meat           TEXT,                        -- เนื้อสัตว์ ("-" becomes NULL, see step 3)
    price          INTEGER NOT NULL DEFAULT 0,  -- ราคา (บาท)
    image_url      TEXT,                        -- รูปภาพ
    theme          TEXT,                        -- 'day' | 'night' | 'both' | 'none' — กะที่เมนูแสดง ('none' = ซ่อนทุกที่)
    available      BOOLEAN NOT NULL DEFAULT true, -- เจ้าของเปิด/ปิดขายรายการนี้
    sort_order     INTEGER,                     -- ลำดับที่เจ้าของลากจัดเอง (NULL = ยังไม่จัด, ไปต่อท้าย)
    subcategory_en TEXT,                        -- หัวข้อ (English, optional)
    name_en        TEXT,                        -- ชื่อรายการ (English, optional)
    meat_en        TEXT                         -- เนื้อสัตว์ (English, optional)
);

-- ==========================================================
-- 1b) Already created the table with an older version of this
--     file? Add just the missing columns instead:
-- ==========================================================
-- ALTER TABLE menu_items ADD COLUMN theme TEXT;
-- ALTER TABLE menu_items ADD COLUMN available BOOLEAN NOT NULL DEFAULT true;
-- Have a CHECK constraint on theme from an older setup? It must allow 'none'
-- (the "hidden everywhere" state the sun/moon pill sets). Update it with:
--   ALTER TABLE menu_items DROP CONSTRAINT menu_items_theme_chk;
--   ALTER TABLE menu_items ADD CONSTRAINT menu_items_theme_chk
--     CHECK (theme = ANY (ARRAY['day','night','both','none']));
-- ALTER TABLE menu_items ADD COLUMN sort_order INTEGER;
-- (sort_order = ลำดับการแสดงในหน้าลูกค้า เจ้าของลากจัดได้ในหน้า "จัดการเมนู"
--  แถวที่ยังเป็น NULL จะไปต่อท้ายเมนู จนกว่าจะลากจัดครั้งแรก)
-- ALTER TABLE menu_items ADD COLUMN subcategory_en TEXT;
-- ALTER TABLE menu_items ADD COLUMN name_en TEXT;
-- ALTER TABLE menu_items ADD COLUMN meat_en TEXT;

-- ==========================================================
-- 2) Import the CSV  -> do this with the GUI (see chat steps),
--    OR use this COPY command if the file path is reachable.
--    On a local Mac install, put the file somewhere readable, e.g.:
-- ==========================================================
-- COPY menu_items (category, type, subcategory, name, meat, price, image_url)
-- FROM '/Users/punnawit/Downloads/Copy of ตู้กับข้าวบ้านยาย Menu - Menu_Main.csv'
-- WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');

-- ==========================================================
-- 3) Clean-up after import (optional but recommended)
-- ==========================================================
-- Turn the "-" and empty strings into real NULLs
UPDATE menu_items SET meat = NULL      WHERE meat = '-' OR meat = '';
UPDATE menu_items SET image_url = NULL WHERE image_url = '';

-- ==========================================================
-- 4) Check it worked
-- ==========================================================
-- SELECT COUNT(*) FROM menu_items;                 -- should be 136
-- SELECT * FROM menu_items ORDER BY id LIMIT 20;
-- SELECT DISTINCT category FROM menu_items;         -- see your 4 categories
