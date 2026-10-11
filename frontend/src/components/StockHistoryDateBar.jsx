import React from 'react';
import { workdayKey } from '../shift';
import { formatThaiDate } from '../expenses';

// The day picker above every view of ประวัติการบันทึกสต็อก. `date` is a working
// day ('YYYY-MM-DD', 06:00 → 06:00); tomorrow is never offered, since a working
// day only closes at 06:00 and nothing has been logged ahead of now.
function StockHistoryDateBar({ date, onChange }) {
  const today = workdayKey();
  return (
    <div className="flex items-center gap-2 font-thai">
      <span className="text-[10px] text-neutral-400 font-bold shrink-0">วันที่</span>
      {/* text-neutral-800 because the box carries its own background — an
          inherited colour goes invisible at night. */}
      <input
        type="date"
        value={date}
        max={today}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 border rounded-xl py-1.5 px-2 text-[11px] font-bold text-neutral-800 bg-admin-field focus:outline-none focus:ring-1 focus:ring-amber-500"
      />
      {date !== today ? (
        <button
          type="button"
          onClick={() => onChange(today)}
          className="text-[10px] font-bold text-amber-700 hover:underline shrink-0"
        >
          กลับเป็นวันนี้
        </button>
      ) : (
        <span className="text-[10px] font-bold text-neutral-500 shrink-0">วันนี้ · {formatThaiDate(date)}</span>
      )}
    </div>
  );
}

export default StockHistoryDateBar;
