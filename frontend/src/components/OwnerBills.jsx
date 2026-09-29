import React from 'react';
import { ReceiptText } from 'lucide-react';
import {
  itemRound,
  itemStatus,
  isDiscountItem,
  singleRoundBase,
  tableLabel,
  ITEM_STATUS_LABELS,
  ITEM_STATUS_COLORS,
} from '../orders';
import { orderDateKey } from '../stats';

// Bill-level status chip (whole order) — same wording/colours as the staff board.
const billStatusLabel = (status) => {
  switch (status) {
    case 'new': return 'รับออเดอร์';
    case 'cooking': return 'อยู่ในครัว';
    case 'served': return 'เสิร์ฟแล้ว';
    case 'paid': return 'เช็กบิลแล้ว';
    case 'cancelled': return 'ยกเลิก';
    default: return status;
  }
};
const billStatusColor = (status) => {
  switch (status) {
    case 'new': return 'bg-[#FDECC8] text-[#8a5a00]';
    case 'cooking': return 'bg-[#DCE9F7] text-[#2F5D8A]';
    case 'served': return 'bg-[#EADBC8] text-[#6B4A2B]';
    case 'paid': return 'bg-[#E9E5DB] text-[#6b6656]';
    case 'cancelled': return 'bg-[#F6DAD7] text-[#9a2c22]';
    default: return 'bg-neutral-100 text-neutral-600';
  }
};
const itemStatusLabel = (s) => ITEM_STATUS_LABELS[s] || s;
const itemStatusColor = (s) => ITEM_STATUS_COLORS[s] || 'bg-neutral-100 text-neutral-600';

// A working-day key ('YYYY-MM-DD') as a Thai date. Noon avoids any DST edge.
const thaiDay = (key) =>
  new Date(`${key}T12:00:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });

// ประวัติบิลทั้งหมด — the same bill cards staff read on their board, brought to
// the owner's finance page as a read-only review (no edit / status / pay
// controls). Always scoped to one working day — the newest one until another
// is picked — so the page never has to draw every bill ever taken.
export default function OwnerBills({ orders = [] }) {
  // Which working day to show — a 'YYYY-MM-DD' key, or '' before a pick.
  const [dateKey, setDateKey] = React.useState('');

  // Working days that actually have bills, newest first, each with its count —
  // so the picker only ever offers days that have something to show.
  const dayOptions = React.useMemo(() => {
    const counts = new Map();
    for (const o of orders) {
      const k = orderDateKey(o);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [orders]);

  // The day actually on screen: the picked one while it still has bills,
  // otherwise the newest day available. Falling back this way covers both the
  // first render (nothing picked yet) and orders arriving/changing later.
  const activeDay = dayOptions.some(([k]) => k === dateKey) ? dateKey : (dayOptions[0]?.[0] || '');

  // Newest bill first, screened to the day on screen.
  const bills = React.useMemo(
    () =>
      orders
        .filter((o) => orderDateKey(o) === activeDay)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [orders, activeDay]
  );

  return (
    <div className="bg-admin-panel border border-line rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="flex items-center gap-2 font-extrabold text-base font-kanit text-neutral-800">
          <ReceiptText className="w-4 h-4 text-neutral-500" />
          ประวัติบิล
        </h3>
        <span className="text-[11px] text-neutral-500 font-medium font-thai">{bills.length} บิล</span>
      </div>

      {/* DATE PICKER — one working day at a time; only days that have bills */}
      {dayOptions.length > 0 && (
        <select
          value={activeDay}
          onChange={(e) => setDateKey(e.target.value)}
          className="w-full border rounded-xl py-2.5 px-3 bg-admin-field text-xs font-bold font-thai focus:outline-none focus:ring-1 focus:ring-amber-500"
        >
          {dayOptions.map(([key, count]) => (
            <option key={key} value={key}>{thaiDay(key)} · {count} บิล</option>
          ))}
        </select>
      )}

      {bills.length === 0 ? (
        <div className="p-6 text-center text-xs text-neutral-400 font-thai">
          {dayOptions.length === 0 ? 'ยังไม่มีบิล' : 'ไม่มีบิลในวันที่เลือก'}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-start">
          {bills.map((order) => (
            <div key={order.id} className="border border-neutral-200 bg-admin-card rounded-2xl p-4 shadow-xs">
              <div className="flex justify-between items-center border-b pb-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className={`font-extrabold text-[11px] px-2 py-0.5 rounded-md font-kanit ${singleRoundBase(order.table) ? 'bg-violet-600 text-white' : 'bg-ctl text-ctl-ink'}`}>
                    {tableLabel(order.table)}
                  </span>
                  <span className="font-mono text-neutral-400 text-xs font-semibold">{order.no}</span>
                </div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${billStatusColor(order.status)}`}>
                  {billStatusLabel(order.status)}
                </span>
              </div>

              {order.invoiceNo && (
                <div className="-mt-1 mb-2 text-[10px] font-mono font-bold text-amber-700">
                  เลขที่บิล: {order.invoiceNo}
                </div>
              )}

              <div className="space-y-1.5 py-1">
                {order.items.map((item, idx) => {
                  const showRoundDivider = idx > 0 && itemRound(item) !== itemRound(order.items[idx - 1]);
                  if (isDiscountItem(item)) {
                    return (
                      <div
                        key={idx}
                        className="flex justify-between items-center gap-2 text-xs font-thai font-bold text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-2 py-1.5"
                      >
                        <span className="flex items-center gap-1.5 min-w-0 truncate">
                          {item.name}
                          {item.by && <span className="font-medium text-rose-500"> · โดย {item.by}</span>}
                        </span>
                        <span className="font-mono shrink-0">-฿{Math.abs(item.price).toLocaleString()}</span>
                      </div>
                    );
                  }
                  return (
                    <React.Fragment key={idx}>
                      {showRoundDivider && (
                        <div className="flex items-center gap-2 pt-1 text-[9px] text-neutral-400 font-semibold">
                          <span className="h-px flex-1 bg-neutral-200" />
                          สั่งเพิ่ม · รอบที่ {itemRound(item)}
                          <span className="h-px flex-1 bg-neutral-200" />
                        </div>
                      )}
                      <div className="space-y-1 pb-0.5">
                        <div className="flex justify-between items-start gap-2 text-xs font-thai text-neutral-800">
                          <div className="min-w-0">
                            <span className="font-bold text-amber-700 mr-1.5">{item.qty}×</span>
                            <span>{item.name}</span>
                            {item.addOns && item.addOns.length > 0 && (
                              <p className="text-[9px] text-neutral-400 pl-5">พิเศษ: {item.addOns.join(', ')}</p>
                            )}
                            {item.note && (
                              <p className="text-[9px] text-red-500 italic pl-5">📝 {item.note}</p>
                            )}
                          </div>
                          <span className="font-mono text-neutral-500 font-medium text-xs flex-shrink-0">
                            ฿{(item.price + (item.addonCost || 0)) * item.qty}
                          </span>
                        </div>
                        <div className="flex justify-end">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${itemStatusColor(itemStatus(item))}`}>
                            {itemStatusLabel(itemStatus(item))}
                          </span>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>

              <div className="border-t border-neutral-100 mt-2.5 pt-2 flex justify-between items-center text-xs">
                <span className="text-[10px] text-neutral-400 font-medium">{order.time} น. · {order.by}</span>
                <b className="font-mono text-neutral-800 font-extrabold">฿{order.total.toLocaleString()}</b>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
