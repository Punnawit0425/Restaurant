// How a stock_history row is presented. Shared by the staff คลังวัตถุดิบ
// ประวัติ panel and the owner's "ตารางที่ 3: ประวัติอัปเดตสต็อก", so the two
// can never label the same movement differently.
//
// The action values come from the server (see schema/stock_history_schema.sql).
// Unknown actions fall back to the raw string / a neutral grey rather than
// rendering blank, so a newly added action is still legible before this list
// catches up.
export const STOCK_ACTION_LABELS = {
  adjust: 'ปรับจำนวน',
  'restock-all': 'เติมทั้งหมด',
  create: 'เพิ่ม/เติมรายการ',
  serve: 'ตัดสต็อก (เสิร์ฟ)',
  unserve: 'คืนสต็อก (ยกเลิกเสิร์ฟ)',
};

export const STOCK_ACTION_COLORS = {
  adjust: 'bg-sky-100 text-sky-700',
  'restock-all': 'bg-emerald-100 text-emerald-700',
  create: 'bg-emerald-100 text-emerald-700',
  serve: 'bg-amber-100 text-amber-700',
  unserve: 'bg-neutral-100 text-neutral-600',
};

// "31 ก.ค. 14:32" — compact Thai date+time for a history row.
export const fmtStockTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('th-TH', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
};
