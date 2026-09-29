import React, { useEffect, useState } from 'react';
import { CheckCircle, Lock } from 'lucide-react';
import { THANKS_MS, sessionPhase } from '../customer-session';

// ---------------------------------------------------------------------------
// The screen a diner's phone shows once their bill has been settled.
// ---------------------------------------------------------------------------
// Two beats, driven purely by how long ago the bill closed (see
// customer-session.js), so a reload lands on the right one instead of
// restarting the countdown:
//
//   'thanks' — the first THANKS_MS: what was paid, for which table, and a
//              countdown so the screen closing is expected rather than a glitch.
//   'locked' — from then on: the menu is gone. Ordering again means asking
//              staff, which is the point — the group has already paid.
//
// There is no "start again" button on purpose. This phone's session is over;
// the next group scans in with their own phones and gets a clean session.
// ---------------------------------------------------------------------------
function SessionClosed({ session, lang = 'th' }) {
  const t = (th, en) => (lang === 'en' && en ? en : th);
  // Re-render once a second so the countdown ticks and the screen flips to the
  // lock by itself, without the diner having to touch anything.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const phase = sessionPhase(session, now);
  const secondsLeft = Math.max(0, Math.ceil((THANKS_MS - (now - session.closedAt)) / 1000));
  const table = session.table;

  if (phase === 'thanks') {
    return (
      <div className="py-10 px-2 font-thai text-center space-y-5">
        <div className="mx-auto w-20 h-20 rounded-full bg-green-500/10 flex items-center justify-center text-green-600">
          <CheckCircle className="w-11 h-11" />
        </div>
        <div className="space-y-1">
          <h2 className="font-kanit font-extrabold text-lg text-title">
            {t('เช็กบิลเรียบร้อยแล้ว', 'Payment complete')}
          </h2>
          <p className="text-xs text-ink-2 font-medium">
            {t('โต๊ะ', 'Table')} {table}
          </p>
        </div>

        <div className="rounded-2xl p-4 space-y-1 bg-card border border-line">
          <p className="text-[11px] font-bold text-ink-2">{t('ยอดที่ชำระ', 'Amount paid')}</p>
          <p className="font-mono font-extrabold text-3xl text-accent">
            ฿{(session.total || 0).toLocaleString()}
          </p>
        </div>

        <p className="text-sm font-kanit font-bold text-title">
          {t('ขอบคุณที่ใช้บริการค่ะ 🙏', 'Thank you for dining with us 🙏')}
        </p>
        <p className="text-[11px] text-ink-2 leading-snug">
          {t(
            `ระบบจะปิดหน้าสั่งอาหารของโต๊ะนี้ใน ${secondsLeft} วินาที`,
            `This table's ordering page will close in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}`
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="py-12 px-2 font-thai text-center space-y-5">
      <div className="mx-auto w-20 h-20 rounded-full bg-strip-soft border border-line flex items-center justify-center text-ink-2">
        <Lock className="w-10 h-10" />
      </div>
      <div className="space-y-1.5">
        <h2 className="font-kanit font-extrabold text-lg text-title">
          {t('เซสชันนี้ปิดแล้ว', 'This session has ended')}
        </h2>
        <p className="text-xs text-ink-2 leading-relaxed">
          {t(
            `บิลของโต๊ะ ${table} ชำระเงินเรียบร้อยแล้ว หน้าสั่งอาหารของรอบนี้จึงถูกปิดลง`,
            `The bill for table ${table} has been settled, so this ordering session is now closed.`
          )}
        </p>
      </div>

      <div className="rounded-2xl p-4 bg-card border border-line space-y-1.5">
        <p className="font-kanit font-bold text-sm text-title">
          {t('ต้องการสั่งอาหารเพิ่ม?', 'Would you like to order more?')}
        </p>
        <p className="text-[11px] text-ink-2 leading-snug">
          {t(
            'กรุณาแจ้งพนักงานที่ร้านเพื่อเปิดโต๊ะรอบใหม่ให้คุณค่ะ',
            'Please ask our staff and they will open a new table session for you.'
          )}
        </p>
      </div>

      <p className="text-sm font-kanit font-bold text-title">
        {t('ขอบคุณที่ใช้บริการค่ะ 🙏', 'Thank you for dining with us 🙏')}
      </p>
    </div>
  );
}

export default SessionClosed;
