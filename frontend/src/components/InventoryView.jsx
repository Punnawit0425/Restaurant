import React, { useState } from 'react';
import { UtensilsCrossed, Package } from 'lucide-react';
import OwnerMenu from './OwnerMenu';
import StockPanel from './StockPanel';

// ผู้จัดการคลัง — the whole back office this role gets: คลัง and จัดการเมนู, and
// nothing else (no order board, no ผู้บริหาร settings, no money). Both tabs are
// the owner's own panels; จัดการเมนู runs in its stockOnly mode, which lists and
// edits only the dishes that have a คลังวัตถุดิบ row. The server enforces the same
// scope on every menu write, so hiding the rest here is not the only guard.
const TABS = [
  { id: 'stock', label: 'คลัง', icon: Package },
  { id: 'menu', label: 'จัดการเมนู', icon: UtensilsCrossed },
];

function InventoryView({ menu, addonPresets, setAddonPresets, showToast }) {
  const [subTab, setSubTab] = useState('stock');

  return (
    <div className="space-y-4 font-thai text-sm">
      {/* Same bar as OwnerView's, but with only two tabs there is room to spell
          the labels out on a phone too. */}
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
    </div>
  );
}

export default InventoryView;
