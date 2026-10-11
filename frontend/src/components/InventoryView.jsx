import React, { useState, useEffect, useMemo } from 'react';
import { UtensilsCrossed, Package, BarChart3 } from 'lucide-react';
import OwnerMenu from './OwnerMenu';
import StockPanel from './StockPanel';
import MenuStatsCard from './MenuStatsCard';
import { SHIFT_TABS } from '../dashboard-format';
import { fetchStockItems } from '../api';

// ผู้จัดการคลัง — the whole back office this role gets: คลัง, จัดการเมนู and
// ดูยอดขาย, and nothing else (no order board, no ผู้บริหาร settings, no money
// book). The tabs are the owner's own panels run in a narrowed mode: จัดการเมนู
// lists and edits only the dishes that have a คลังวัตถุดิบ row, and ดูยอดขาย is the
// owner's สถิติเมนู table locked to those same dishes. The server enforces the
// same scope on every menu write, so hiding the rest here is not the only guard.
const TABS = [
  { id: 'stock', label: 'คลัง', icon: Package },
  { id: 'menu', label: 'จัดการเมนู', icon: UtensilsCrossed },
  { id: 'sales', label: 'ดูยอดขาย', icon: BarChart3 },
];

// Matched the way the DATABASE matches a dish to its stock row — LOWER(TRIM),
// see consumeStockByName (and the same helper in OwnerMenu).
const stockKey = (v) => String(v || '').trim().toLowerCase();

function InventoryView({ menu, orders, menuPresets, addonPresets, setAddonPresets, showToast }) {
  const [subTab, setSubTab] = useState('stock');
  const [shift, setShift] = useState('all');

  // ดูยอดขาย: the LOWER(TRIM) names of every คลัง row. null until the first read
  // answers, so the table says it is loading rather than flashing every dish.
  // Re-read on opening the tab and whenever the menu changes: the คลัง itself is
  // not on the SSE stream, and a dish added through เพิ่มเมนูในสต็อก arrives with
  // a new คลัง row.
  const [stockNames, setStockNames] = useState(null);
  const [stockNamesError, setStockNamesError] = useState('');
  useEffect(() => {
    if (subTab !== 'sales') return;
    let cancelled = false;
    fetchStockItems()
      .then((items) => {
        if (cancelled) return;
        setStockNames(new Set((items || []).map((s) => stockKey(s.name))));
        setStockNamesError('');
      })
      .catch((err) => { if (!cancelled) setStockNamesError(err.message || 'โหลดคลังไม่สำเร็จ'); });
    return () => { cancelled = true; };
  }, [subTab, menu]);

  // The menu's own spelling of each stocked dish — the stats table matches sold
  // lines by the menu name, not the คลัง row's.
  const scopeNames = useMemo(
    () => (stockNames
      ? new Set((menu || []).filter((m) => stockNames.has(stockKey(m.name))).map((m) => m.name))
      : null),
    [menu, stockNames]
  );

  return (
    <div className="space-y-4 font-thai text-sm">
      {/* Same bar as OwnerView's, but with only three tabs there is room to
          spell the labels out on a phone too. */}
      <div className="flex gap-1 bg-admin-bar rounded-xl p-1 text-[10px] font-bold">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setSubTab(tab.id)}
              className={`flex-1 py-2.5 px-0.5 rounded-lg flex items-center justify-center gap-1.5 transition ${tab.id === subTab ? 'bg-admin-tab text-admin-tab-ink shadow-sm' : 'text-admin-tab-idle hover:text-admin-tab-hover'}`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              <span className="text-xs font-kanit">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {subTab === 'stock' && <StockPanel menu={menu} showToast={showToast} />}
      {subTab === 'menu' && (
        <OwnerMenu
          menu={menu}
          addonPresets={addonPresets}
          setAddonPresets={setAddonPresets}
          showToast={showToast}
          stockOnly
        />
      )}
      {subTab === 'sales' && (
        <div className="space-y-4">
          {/* Same shift split as the owner's dashboard. */}
          <div className="flex gap-1.5 bg-neutral-100 rounded-xl p-1 text-[11px] font-bold">
            {SHIFT_TABS.map(t => (
              <button
                key={t.id}
                onClick={() => setShift(t.id)}
                className={`flex-1 py-2 rounded-lg transition ${t.id === shift ? 'bg-admin-field text-neutral-800 shadow-xs' : 'text-neutral-500'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* No setMenuPresets: presets are the owner's to write, so here they
              can be picked but not edited — and a preset only ever narrows the
              stocked dishes, never reaches past them. */}
          <MenuStatsCard
            orders={orders}
            expenses={[]}
            menu={menu}
            shift={shift}
            menuPresets={menuPresets}
            showToast={showToast}
            scopeNames={scopeNames}
            presetOnly
          />

          <p className={`pl-1 text-[10px] font-medium ${stockNamesError ? 'text-red-500' : 'text-amber-700'}`}>
            {stockNamesError
              ? `โหลดรายการในคลังไม่สำเร็จ: ${stockNamesError}`
              : 'แสดงเฉพาะเมนูที่อยู่ในคลังวัตถุดิบ'}
          </p>
        </div>
      )}
    </div>
  );
}

export default InventoryView;
