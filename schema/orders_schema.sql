-- ==========================================================
-- ตู้กับข้าวบ้านยาย — Orders (ยอดขาย) table
-- ==========================================================
-- หมายเหตุ: ปกติ "ไม่ต้องรันไฟล์นี้" — เซิร์ฟเวอร์สร้างตารางนี้ให้อัตโนมัติ
-- ตอนเปิดด้วย npm run dev (ดู backend/orders-db.js)
-- ไฟล์นี้มีไว้เพื่อ (ก) ดูโครงสร้าง (ข) สร้างเองใน pgAdmin ถ้าต้องการ
-- ==========================================================

CREATE TABLE IF NOT EXISTS orders (
    id         TEXT PRIMARY KEY,                    -- รหัสบิล เช่น 'B1234'
    no         TEXT,                                -- เลขลำดับที่แสดง เช่น '#001'
    invoice_no TEXT,                                -- เลขที่บิล YYMMDD-D/N-0000 (ถ้ามี)
    table_no   TEXT,                                -- หมายเลขโต๊ะ
    status     TEXT NOT NULL DEFAULT 'new',         -- new/cooking/served/paid/cancelled
    shift      TEXT,                                -- 'day' หรือ 'night'
    total      NUMERIC(12,2) NOT NULL DEFAULT 0,    -- ยอดรวม (บาท)
    order_time TEXT,                                -- เวลาที่แสดง เช่น '19:45'
    created_at BIGINT,                              -- เวลาสร้าง (epoch milliseconds)
    note       TEXT,                                -- หมายเหตุ
    by_user    TEXT,                                -- พนักงานที่ลงบิล
    items      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- รายการอาหารในบิล
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- ออเดอร์ทั้งก้อน (กันข้อมูลหาย)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_status_idx     ON orders (status);


-- ==========================================================
-- ตัวอย่างคำสั่งดูรายงาน (รันใน Query Tool ของ pgAdmin ได้เลย)
-- ==========================================================

-- ดูบิลทั้งหมด ล่าสุดก่อน
-- SELECT id, table_no, status, total, order_time,
--        to_timestamp(created_at / 1000) AS created
-- FROM orders
-- ORDER BY created_at DESC;

-- ยอดขายรวมที่เก็บเงินแล้ว
-- SELECT SUM(total) AS ยอดขายรวม FROM orders WHERE status = 'paid';

-- ยอดขายรายวัน แยกกะกลางวัน/กลางคืน
-- SELECT to_char(to_timestamp(created_at / 1000), 'YYYY-MM-DD') AS วันที่,
--        shift AS กะ,
--        COUNT(*) AS จำนวนบิล,
--        SUM(total) AS ยอดขาย
-- FROM orders
-- WHERE status = 'paid'
-- GROUP BY 1, 2
-- ORDER BY 1 DESC, 2;

-- เมนูขายดี (แตกรายการอาหารออกจาก JSON)
-- SELECT item->>'name' AS เมนู,
--        SUM((item->>'qty')::int) AS จำนวนที่ขายได้
-- FROM orders, jsonb_array_elements(items) AS item
-- WHERE status = 'paid'
-- GROUP BY 1
-- ORDER BY 2 DESC
-- LIMIT 20;
