import React from 'react';
import { QrCode } from 'lucide-react';

// ---------------------------------------------------------------------------
// QR Code ประจำโต๊ะ (Owner > ตั้งค่า)
// ---------------------------------------------------------------------------
// One printable QR per table — the shift is not baked into the sticker, it is
// decided when the code is scanned, from the Bangkok clock (06:00–16:59 opens
// the day storefront, 17:00–05:59 the night bar). That is why there is a single
// sticker per table rather than a day one and a night one: the same sticker
// stays on the table around the clock and follows the shop.
//
// This used to be a tab on the staff screen, but printing table stickers is a
// once-a-setup job for the owner, not something a server does mid-shift — so it
// lives in the back office next to the setting (`settings.tables`) that decides
// how many are produced.
//
// Pure presentation: it reads `settings` and writes nothing.
// ---------------------------------------------------------------------------

function TableQrCodes({ settings }) {
  // Where the codes point. `baseUrl` is set in ตั้งค่าร้าน for the case where the
  // shop is reached on a different address than the one this tab was opened on
  // (a tunnel, a LAN IP); otherwise the current address is the right answer.
  const baseUrl = settings.baseUrl || window.location.origin + window.location.pathname;
  const tables = Math.max(0, Number(settings.tables) || 0);
  const qrSrc = (url) => `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  const takeawayUrl = `${baseUrl}?takeaway`;

  return (
    <div className="bg-admin-card border rounded-2xl p-4 space-y-4 shadow-xs font-thai text-xs">
      <div>
        <h3 className="font-kanit font-extrabold text-xs text-neutral-400 uppercase tracking-wider">
          พิมพ์/บันทึก QR Code ประจำโต๊ะ และสั่งกลับบ้าน
        </h3>
        <span className="text-[10px] text-neutral-400 font-medium">
          โต๊ะละ 1 QR ใช้ได้ทั้งวัน — ระบบเลือกกะให้เองตามเวลาประเทศไทย
          (06:00–16:59 เข้าเมนูกลางวัน · 17:00–05:59 เข้าเมนูกลางคืน)
          จำนวนโต๊ะปรับได้ที่ "ตั้งค่าร้าน" ด้านบน
        </span>
      </div>

      {/* สั่งกลับบ้าน — ONE code for the counter (or the shop window), not one
          per customer: every phone that scans it opens its own กลับบ้าน #N
          bill, numbered in order and restarted at #1 each shift. */}
      <div className="bg-violet-50 border border-violet-200 rounded-2xl p-3 flex items-center gap-3">
        <div className="w-28 h-28 flex-shrink-0 bg-white rounded-xl border flex items-center justify-center p-1.5 shadow-inner">
          <img src={qrSrc(takeawayUrl)} className="w-full h-full object-contain" alt="QR สั่งกลับบ้าน" />
        </div>
        <div className="min-w-0 space-y-1.5">
          <b className="font-kanit text-neutral-400 text-sm block">สั่งกลับบ้าน (Takeaway)</b>
          <p className="text-[10px] text-neutral-400 leading-snug">
            QR เดียวใช้ได้ทุกคน — ลูกค้าแต่ละเครื่องจะได้บิลของตัวเองเป็น กลับบ้าน #1, #2, #3 …
            ตามลำดับการสั่ง และเริ่มนับ #1 ใหม่ทุกกะ (กลางวัน / กลางคืน)
          </p>
          <p className="text-[9px] text-neutral-400 font-mono break-all leading-tight">{takeawayUrl}</p>
          <a
            href={qrSrc(takeawayUrl)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[9px] bg-ctl hover:bg-ctl-hover text-ctl-ink font-bold px-2 py-1 rounded-lg transition"
          >
            <QrCode className="w-3 h-3" />
            <span>ดาวน์โหลด</span>
          </a>
        </div>
      </div>

      {tables > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: tables }, (_, i) => {
            const table = i + 1;
            // A plain ?table=N link: no shift in it, so the customer app reads
            // the Bangkok clock on arrival (see shiftNow() in shift.js) and
            // opens the shop that is actually running.
            const url = `${baseUrl}?table=${table}`;
            const src = qrSrc(url);

            return (
              <div
                key={table}
                className="bg-admin-field border border-neutral-200 rounded-2xl p-3 w-full flex flex-col items-center space-y-2"
              >
                <b className="font-kanit text-neutral-800 text-sm block text-center">โต๊ะ {table}</b>

                <div className="w-full aspect-square bg-neutral-50 rounded-xl border flex items-center justify-center p-2 shadow-inner">
                  <img src={src} className="w-full h-full object-contain" alt={`QR โต๊ะ ${table}`} />
                </div>
                <p className="text-[9px] text-neutral-400 font-mono break-all text-center leading-tight">{url}</p>
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[10px] bg-ctl hover:bg-ctl-hover text-ctl-ink font-bold px-2 py-1 rounded-lg transition"
                >
                  <QrCode className="w-3 h-3" />
                  <span>ดาวน์โหลด</span>
                </a>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-center py-6 text-neutral-400 font-medium">
          ยังไม่ได้ตั้งจำนวนโต๊ะ — กรอกจำนวนโต๊ะที่ "ตั้งค่าร้าน" ก่อน
        </p>
      )}
    </div>
  );
}

export default TableQrCodes;
