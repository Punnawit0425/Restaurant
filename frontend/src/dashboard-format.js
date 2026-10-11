// Small display helpers shared by the owner's dashboard and the สถิติเมนู card
// (which the ผู้จัดการคลัง's ดูยอดขาย tab reuses). Kept out of the component
// files so those export nothing but components.
import { THAI_MONTHS_FULL } from './expenses';

// 'YYYY-MM' -> 'กรกฎาคม 2569'
export function monthLabel(key) {
  const [y, m] = (key || '').split('-').map(Number);
  if (!y || !m) return key || '';
  return `${THAI_MONTHS_FULL[m - 1]} ${y + 543}`;
}

// `|| 0` is not redundant: rounding a tiny negative — or landing on JavaScript's
// negative zero, which Math.ceil(-0.1) * step produces for the axis tick at
// break-even — formats as the string "-0".
export const baht = (n) => (Math.round(n) || 0).toLocaleString();

export const SHIFT_TABS = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'day', label: 'กลางวัน' },
  { id: 'night', label: 'กลางคืน' }
];
