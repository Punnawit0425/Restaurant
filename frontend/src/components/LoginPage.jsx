import React, { useState } from 'react';
import { LogIn, User, Lock, Loader2, KeyRound, ArrowLeft } from 'lucide-react';
import logoImg from '../assets/logo.jpg';

// ---------------------------------------------------------------------------
// Full-screen staff / owner login.
// ---------------------------------------------------------------------------
// This is the app's front door for everyone who is NOT a customer: a diner only
// ever reaches the menu by scanning a table QR (…?table=N), so the plain site
// URL lands here instead of on a customer view. `onLogin` returns a promise
// that resolves on success and rejects with the server's message on bad
// credentials; App decides which panel to route to from the role it gets back.
//
// It has a second step. The owner can create an account without a password, and
// the person it belongs to chooses one the first time they sign in: `onLogin`
// resolves with { mustSetPassword } instead of a session, and this screen turns
// into "ตั้งรหัสผ่านของคุณ". `onClaimAccount` saves it and signs them straight in.
// ---------------------------------------------------------------------------
export default function LoginPage({ onLogin, onClaimAccount, settings }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Set once the server says this account has no password yet: { user, name }.
  // While it is set, the card shows the create-password step instead of login.
  const [claiming, setClaiming] = useState(null);
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');

  const backToLogin = () => {
    setClaiming(null);
    setNewPass('');
    setConfirmPass('');
    setError('');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const result = await onLogin(user.trim(), pass);
      if (result?.mustSetPassword) {
        setClaiming({ user: result.user, name: result.name });
        setPass('');
        setBusy(false);
        return;
      }
      // On success App swaps this whole screen out, so no cleanup needed here.
    } catch (err) {
      setError(err?.message || 'เข้าสู่ระบบไม่สำเร็จ');
      setBusy(false);
    }
  };

  // Step two: the password this person is choosing for their own account.
  const submitNewPassword = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (newPass.length < 4) return setError('รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร');
    if (newPass !== confirmPass) return setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
    setError('');
    setBusy(true);
    try {
      await onClaimAccount(claiming.user, newPass);
    } catch (err) {
      setError(err?.message || 'ตั้งรหัสผ่านไม่สำเร็จ');
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-10 font-thai">
      <div className="w-full max-w-xs space-y-6">
        {/* Brand */}
        <div className="text-center space-y-3">
          <span className="w-20 h-20 mx-auto rounded-2xl overflow-hidden flex items-center justify-center shadow-lg ring-1 ring-black/10 bg-logo">
            <img src={logoImg} alt="โลโก้ร้าน" className="w-full h-full object-cover" />
          </span>
          <div>
            <h1 className="font-kanit font-extrabold text-xl text-ink leading-tight">
              {settings?.name || 'เข้าสู่ระบบ'}
            </h1>
            <p className="text-xs text-ink-3 mt-1">สำหรับพนักงานและเจ้าของร้านเท่านั้น</p>
          </div>
        </div>

        {/* CREATE PASSWORD — first sign-in on an account the owner made without
            one. Nothing here identifies the person beyond the username they just
            typed; the account is not usable until this is saved. */}
        {claiming ? (
          <form
            onSubmit={submitNewPassword}
            className="bg-admin-card rounded-2xl p-5 space-y-4 border border-neutral-100 shadow-2xl text-neutral-800"
          >
            <div className="text-center space-y-1">
              <span className="w-10 h-10 mx-auto rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center">
                <KeyRound className="w-5 h-5 text-amber-700" />
              </span>
              <h2 className="font-kanit font-extrabold text-sm">ตั้งรหัสผ่านของคุณ</h2>
              <p className="text-[11px] text-neutral-500 leading-relaxed">
                บัญชี <span className="font-bold text-neutral-700">{claiming.name || claiming.user}</span> ยังไม่มีรหัสผ่าน
                <br />ตั้งรหัสผ่านครั้งแรกเพื่อเข้าใช้งาน แล้วใช้รหัสนี้ทุกครั้งต่อไป
              </p>
            </div>

            <div>
              <label className="block font-bold text-neutral-500 text-xs mb-1">รหัสผ่านใหม่</label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="password"
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  autoFocus
                  className="w-full border rounded-xl py-3 pl-9 pr-3 bg-admin-field focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                  placeholder="อย่างน้อย 4 ตัวอักษร"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block font-bold text-neutral-500 text-xs mb-1">ยืนยันรหัสผ่าน</label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="password"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  className="w-full border rounded-xl py-3 pl-9 pr-3 bg-admin-field focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                  placeholder="พิมพ์รหัสผ่านอีกครั้ง"
                  required
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-50 text-red-700 text-[11px] font-semibold rounded-xl px-3 py-2 text-center">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 font-bold py-3 rounded-xl transition text-white text-sm"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              <span>{busy ? 'กำลังบันทึก...' : 'บันทึกรหัสผ่าน และเข้าสู่ระบบ'}</span>
            </button>

            <button
              type="button"
              onClick={backToLogin}
              disabled={busy}
              className="w-full flex items-center justify-center gap-1.5 text-[11px] font-bold text-neutral-500 hover:text-neutral-700 disabled:opacity-60"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              ย้อนกลับ
            </button>
          </form>
        ) : (
        /* SIGN IN — the ordinary card. */
        <form
          onSubmit={submit}
          className="bg-admin-card rounded-2xl p-5 space-y-4 border border-neutral-100 shadow-2xl text-neutral-800"
        >
          <div>
            <label className="block font-bold text-neutral-500 text-xs mb-1">ชื่อผู้ใช้งาน</label>
            <div className="relative">
              <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full border rounded-xl py-3 pl-9 pr-3 bg-admin-field focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                placeholder="เช่น admin"
                required
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-neutral-500 text-xs mb-1">รหัสผ่าน</label>
            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
              {/* Not `required`: an account the owner created without a password
                  has nothing to type here, and the server answers that first
                  sign-in with the create-password step. */}
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                className="w-full border rounded-xl py-3 pl-9 pr-3 bg-admin-field focus:ring-2 focus:ring-amber-500 focus:outline-none text-sm"
                placeholder="รหัสผ่าน"
              />
            </div>
            <p className="text-[10px] text-neutral-400 mt-1">
              ถ้าเพิ่งได้รับบัญชีและยังไม่มีรหัสผ่าน ให้เว้นช่องนี้ว่างไว้
            </p>
          </div>

          {/* No "remember me": the session is never saved to this device, so
              closing or reloading the page signs out. Said plainly here, or the
              next visit reads as the app having lost the login. */}
          <p className="text-[10px] text-neutral-400 text-center leading-relaxed">
            ระบบไม่จดจำการเข้าสู่ระบบ — ต้องลงชื่อเข้าใช้ใหม่ทุกครั้งที่เปิดหน้านี้
          </p>

          {error && (
            <div className="bg-red-50 text-red-700 text-[11px] font-semibold rounded-xl px-3 py-2 text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 font-bold py-3 rounded-xl transition text-white text-sm"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            <span>{busy ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}</span>
          </button>
        </form>
        )}

        <p className="text-[10px] text-center text-ink-3 leading-relaxed">
          ลูกค้าเข้าสั่งอาหารได้โดยการสแกน QR ที่โต๊ะเท่านั้น
        </p>
      </div>
    </div>
  );
}
