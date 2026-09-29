import React, { useEffect, useRef, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { verifyStaffPin } from '../api';

// ---------------------------------------------------------------------------
// ใส่ไอดีพนักงาน — putting a name on an action
// ---------------------------------------------------------------------------
// Some actions must be attributable to a PERSON, not to whichever account the
// tablet at the till happens to be signed in as: printing a bill and granting a
// discount both end up on paper with a name against them. One shared login for
// the whole shift would make that name meaningless — anyone could print under
// anyone else's.
//
// So those actions come through here. The 4-digit ไอดีพนักงาน is checked by the
// server (the staff panel is never given the staff list, so it CANNOT be checked
// here) and the caller is handed back the account it belongs to.
//
//   onVerified({ user, name, role, position })  — the person who typed it
//   onCancel()                                  — backed out, nothing happened
//
// The dialog owns the whole exchange: typing, the request, the error, the busy
// state. Callers just say what is being signed and what to do with the answer.
// ---------------------------------------------------------------------------
function PinGate({ title, detail, confirmLabel = 'ยืนยัน', onVerified, onCancel }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    if (!/^\d{4}$/.test(pin)) {
      setError('ไอดีพนักงานเป็นตัวเลข 4 หลัก');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const person = await verifyStaffPin(pin);
      onVerified(person);
    } catch (err) {
      // A wrong code clears the box rather than leaving the bad digits in it —
      // at a busy till the next tap should be the first digit of a fresh try.
      setPin('');
      setError(err.message || 'ไอดีพนักงานไม่ถูกต้อง');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs z-[300] flex items-center justify-center p-4 font-thai">
      <form
        onSubmit={submit}
        className="bg-admin-card rounded-2xl w-full max-w-xs p-5 space-y-4 shadow-2xl text-neutral-800"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-amber-500/10 text-amber-600 flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h3 className="font-kanit font-extrabold text-sm leading-tight">{title}</h3>
              {detail && <p className="text-[11px] text-neutral-500 leading-snug mt-0.5">{detail}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 -mr-1 -mt-1 rounded-lg text-neutral-400 hover:bg-neutral-100 transition shrink-0"
            aria-label="ปิด"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-neutral-400 block">
            ไอดีพนักงาน (4 หลัก)
          </label>
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(''); }}
            placeholder="••••"
            className="w-full border rounded-xl p-3 bg-admin-field focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-center text-2xl tracking-[0.6em] indent-[0.6em]"
          />
          {error && <p className="text-[11px] font-bold text-red-600">{error}</p>}
        </div>

        <div className="flex gap-2 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-bold py-2.5 rounded-xl transition"
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            disabled={busy || pin.length < 4}
            className="flex-1 bg-amber-600 hover:bg-amber-700 disabled:bg-neutral-200 disabled:text-neutral-400 text-white font-bold py-2.5 rounded-xl transition"
          >
            {busy ? 'กำลังตรวจสอบ…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export default PinGate;
