// ---------------------------------------------------------------------------
// Frontend -> Backend bridge
// ---------------------------------------------------------------------------
// Thin client for the shared-state backend. During `npm run dev`, Vite proxies
// every "/api" request to the backend (see vite.config.js), so we can use plain
// relative URLs here and never worry about ports or CORS.
// ---------------------------------------------------------------------------

// --- Session token ----------------------------------------------------------
// The staff session token issued by POST /api/login. Writes to protected
// resources send it as a Bearer token.
//
// IN MEMORY ONLY, on purpose. Nothing about a login is written to disk, so
// closing the tab — or just reloading it — ends the session and the next person
// to open the link gets the login page. On a till or a phone that lives on the
// counter all day, a remembered login is a back office anyone can walk up to.
let authToken = null;

// A session stored by an older build would otherwise sit in localStorage
// forever, holding a usable token. Clear it once, on load.
try {
  localStorage.removeItem('session');
} catch {
  // Private-mode browsers can throw on storage access; nothing to clean up then.
}

export function setAuthToken(token) {
  authToken = token || null;
}

export function getAuthToken() {
  return authToken;
}

// Log in as a staff member. Returns { token, user, name } on success; throws
// with the server's message on bad credentials or rate limiting.
//
// One non-error case has no token: an account the owner created without a
// password answers { mustSetPassword: true, user, name } instead, and the caller
// must send the person to claimAccount() to choose one.
export async function login(user, pass) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, pass }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'เข้าสู่ระบบไม่สำเร็จ');
  }
  if (data.token) setAuthToken(data.token);
  return data;
}

// Set the password on an account that has none, and sign in with it. Same
// response shape as login(). Refused by the server if the account already has a
// password, so this can never be used to reset somebody else's.
export async function claimAccount(user, pass) {
  const res = await fetch('/api/login/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, pass }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'ตั้งรหัสผ่านไม่สำเร็จ');
  }
  setAuthToken(data.token);
  return data;
}

// Fetch the shared state once (used on first load). Sends the session token when
// there is one, so an owner/staff receives the fields the server gates behind a
// login (expenses / payroll / time clock / staff HR); a customer gets the public
// slice.
export async function fetchState() {
  const headers = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/state', { headers });
  if (!res.ok) throw new Error('Failed to load state from backend');
  return res.json();
}

// Replace one resource on the backend. The backend then broadcasts the new
// state to every connected tab over SSE. Fire-and-forget: the UI already
// updated optimistically, so we only log network failures. Protected resources
// (menu / stock / staff / settings) need a valid session token — `onAuthError`
// is called if the server rejects the write as unauthenticated.
export function saveResource(resource, value, onAuthError) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(`/api/${resource}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(value),
  })
    .then((res) => {
      if (res.status === 401 && typeof onAuthError === 'function') onAuthError();
      return res;
    })
    .catch((err) => {
      console.error(`[api] Could not save "${resource}" to backend:`, err);
    });
}

// --- Menu management (owner) ------------------------------------------------
// These all go through endpoints that require a staff session, and they change
// the DATABASE rather than the in-memory state — a write to state.menu would be
// overwritten by the next database sync a few seconds later.
//
// Each one throws with the server's Thai message so the caller can put it
// straight into a toast.
async function authedJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A failure the server explained is shown as it wrote it. Anything else
    // means the reply was not the JSON we expect — a 404 from a backend that
    // has not been restarted onto the current code, a proxy error, a login
    // that has expired into a redirect — so the status code goes into the
    // toast. Without it every one of those reads as the same "ทำรายการไม่สำเร็จ"
    // and there is nothing to tell them apart by.
    throw new Error(data.error || `ทำรายการไม่สำเร็จ (HTTP ${res.status})`);
  }
  return data;
}

// Dropdown values (หมวดหมู่ / ประเภท / หัวข้อ) as they exist in the database.
export function fetchMenuOptions() {
  return authedJson('/api/menu/options');
}

// Send one already-resized image. Returns { url: '/uploads/xxx.jpg' }.
// No Content-Type header here on purpose: fetch has to set the multipart
// boundary itself, and naming the type would strip it and break the parse.
export function uploadMenuImage(file) {
  const body = new FormData();
  body.append('image', file);
  return authedJson('/api/menu/upload', { method: 'POST', body });
}

// Add a dish (one row per protein option, handled server-side).
export function createMenuItem(item) {
  return authedJson('/api/menu/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
}

// Read one dish back in its editable form ({ category, type, subcategory, name,
// theme, imageUrl, price, variants }), to pre-fill the owner's edit form.
export function fetchMenuItem(id) {
  return authedJson(`/api/menu/items/${encodeURIComponent(id)}`);
}

// Overwrite an existing dish with a new spec (same shape as createMenuItem).
export function updateMenuItem(id, item) {
  return authedJson(`/api/menu/items/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
}

// Remove a dish (and every protein row behind it) from the menu for good.
export function deleteMenuItem(id) {
  return authedJson(`/api/menu/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Put a dish on or off sale, by its stable dish id.
export function setMenuAvailability(id, available) {
  return authedJson('/api/menu/items/availability', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, available }),
  });
}

// Set which shift(s) a dish shows in: 'day' | 'night' | 'both' | 'none'.
// 'none' hides it from every storefront (the owner's sun/moon pill sends this).
export function setMenuTheme(id, theme) {
  return authedJson('/api/menu/items/theme', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, theme }),
  });
}

// Save the menu's running order — `ids` is every dish id in the order the owner
// arranged them in. The customer menu shows dishes (and its section headings) in
// this order, so it is a storefront change, not just an admin-list preference.
export function setMenuOrder(ids) {
  return authedJson('/api/menu/order', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

// --- Stock (คลังวัตถุดิบ) ----------------------------------------------------
// The staff inventory tab reads/writes the `stock_items` table via these. They
// require a staff session, like the menu-management calls above.

// The whole inventory: [{ id, category, name, quantity, imageUrl }].
export async function fetchStockItems() {
  const { items } = await authedJson('/api/stock-items');
  return items;
}

// Adjust one item by delta (+1 / +10 / -1 ...). An optional `reason` explains a
// removal (e.g. "เจ้าของดื่มเอง") and is recorded in the stock history. Returns
// the updated item.
export async function adjustStockItem(id, delta, reason) {
  const { item } = await authedJson(`/api/stock-items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta, reason }),
  });
  return item;
}

// Replace one stock row's photo. Called when the owner changes a dish's picture
// from the menu screen so the linked คลัง row keeps the same image. Returns the
// updated item.
export async function updateStockItemImage(id, imageUrl) {
  const { item } = await authedJson(`/api/stock-items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl }),
  });
  return item;
} 

// Remove one row from คลังวัตถุดิบ for good (owner clearing out an orphan).
export async function deleteStockItem(id) {
  const { item } = await authedJson(`/api/stock-items/${id}`, { method: 'DELETE' });
  return item;
}

// Public stock levels for the customer storefront (no auth). Returns
// [{ name, quantity }] so the menu can grey out a dish whose stock hit 0.
export async function fetchStockAvailability() {
  const res = await fetch('/api/stock-availability');
  if (!res.ok) return [];
  const { items } = await res.json();
  return items || [];
}

// Create a stock item (or top up one with the same name). Returns the resulting
// row. Used by the owner's "เพิ่มเมนูในสต็อก" action. Staff session required.
export async function createStockItem({ category, name, quantity, imageUrl }) {
  const { item } = await authedJson('/api/stock-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, name, quantity, imageUrl }),
  });
  return item;
}

// Deduct qty from the stock row matching a dish name (negative qty restores).
// Fired when staff mark a dish เสิร์ฟแล้ว. Returns the updated row, or null if
// no stock row carries that name (the dish just isn't stock-linked).
export async function consumeStockByName(name, qty) {
  const { item } = await authedJson('/api/stock-items/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, qty }),
  });
  return item;
}

// The stock audit trail (ประวัติการบันทึกสต็อก) — who changed what, newest
// first. Returns [{ id, itemName, category, action, delta, quantityAfter,
// byUser, byName, createdAt }].
export async function fetchStockHistory(limit = 200) {
  const { items } = await authedJson(`/api/stock-history?limit=${encodeURIComponent(limit)}`);
  return items;
}

// Bump every item by delta ("เติมทั้งหมด"). Returns how many rows changed.
export async function restockAllStock(delta) {
  const { changed } = await authedJson('/api/stock-items/restock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delta }),
  });
  return changed;
}

// --- Time clock (ลงเวลาเข้า-ออกงาน) -----------------------------------------
// Clock in/out from anywhere — the session says who, the server stamps its own
// clock for when. First call today = clock-in, second = clock-out.
// Returns { action: 'in' | 'out', record }.
export async function clockTime() {
  const { action, record } = await authedJson('/api/timeclock/clock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return { action, record };
}

// Owner backfill: create/correct a staff member's in-out for one day. `inAt`/
// `outAt` are epoch ms (outAt may be null). Staff session required.
export async function manualTimeclock({ user, date, inAt, outAt }) {
  const { record } = await authedJson('/api/timeclock/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, date, inAt, outAt }),
  });
  return record;
}

// Owner sets one staff member's monthly payroll status ('paid' | 'unpaid').
export async function setPayrollStatus({ user, month, status }) {
  await authedJson('/api/timeclock/payroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, month, status }),
  });
}

// Identify the person at the till from their 4-digit ไอดีพนักงาน. Resolves to
// { user, name, role, position } when the code matches an account, and REJECTS
// (with the server's Thai message) when it does not — the codes are only ever
// checked on the server, since the staff panel is never sent the staff list.
//
// Used by every action that has to carry a person's name rather than a device's:
// printing a bill, granting a discount.
export async function verifyStaffPin(pin) {
  return authedJson('/api/staff/verify-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: String(pin || '') }),
  });
}

// Owner edits one staff account. `patch` may carry any of { user, name, pass,
// pin, dailyWage }; anything left out keeps its stored value, and an empty
// `pass`/`pin` means "leave that one alone".
//
// Not done by writing the whole staff array: renaming someone has to move their
// time-clock and payroll history onto the new username, which only the server
// can do. Returns the account as it now stands.
export function updateStaffAccount(user, patch) {
  return authedJson(`/api/staff/${encodeURIComponent(user)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

// Resolve a stored image value into something an <img src> can use.
//
// Two shapes live in image_url side by side: the external links the menu was
// originally imported with (https://i.postimg.cc/...), which are used as-is,
// and the root-relative paths uploads produce (/uploads/xxx.jpg), which resolve
// against the current origin — Vite proxies /uploads to the backend in dev, and
// in production both are served from the same host.
export function resolveImageUrl(image) {
  const src = String(image || '').trim();
  if (!src) return '';
  if (/^https?:\/\//i.test(src) || src.startsWith('data:')) return src;
  return src.startsWith('/') ? src : `/${src}`;
}

// --- Live state pushes (ONE SSE connection per browser, not per tab) ---------
// An EventSource is a connection held open forever, and a browser allows only 6
// per origin over HTTP/1.1 — shared across every tab. One stream per tab meant
// that opening a 6th tab used the last slot and the 7th could not even load the
// page: every request queued behind the streams and the app just spun.
//
// So the tabs elect a LEADER. Only the leader holds the EventSource; it relays
// each push to the other tabs over a BroadcastChannel, which costs no
// connection. The leader renews a timestamp in localStorage every couple of
// seconds; if it stops (tab closed, crashed, asleep) any other tab sees the
// stale stamp and takes the stream over.
//
// Election is scoped by session token: a customer tab and a staff tab must NOT
// share a stream, because the backend sanitises each stream to what that session
// is allowed to see. Same login ⇒ same scope ⇒ one connection.
const LEADER_HEARTBEAT_MS = 2000;
// Long enough that a leader whose timers are being throttled (a backgrounded
// tab) is not declared dead constantly, short enough that closing the leader
// tab hands the stream over almost immediately.
const LEADER_STALE_MS = 6000;

// A short, stable id for "which session is this" — used only to keep separate
// logins on separate channels, never sent anywhere.
function sessionScope(token) {
  if (!token) return 'anon';
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = ((h << 5) + h + token.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Subscribe to live state pushes. `onState` is called every time anything changes
// in any tab (the initial snapshot comes from fetchState, not from here). Returns
// an unsubscribe function; re-call after login/logout so the stream re-scopes.
export function subscribeToState(onState) {
  const token = authToken;
  const scope = sessionScope(token);
  const leaderKey = `sseLeader:${scope}`;
  const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  const emit = (data) => {
    try {
      onState(data);
    } catch (err) {
      console.error('[api] State handler failed:', err);
    }
  };

  let source = null; // EventSource — open only while this tab is the leader
  let stopped = false;

  const openStream = () => {
    if (source || stopped) return;
    const url = token ? `/api/events?token=${encodeURIComponent(token)}` : '/api/events';
    source = new EventSource(url);
    source.addEventListener('state', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (err) {
        console.error('[api] Bad state payload from backend:', err);
        return;
      }
      emit(data);
      if (channel) {
        channel.postMessage({ type: 'state', data });
        // Renew the lease here too, not only on the interval: a backgrounded tab
        // has its timers throttled to about once a minute, but SSE messages keep
        // arriving — without this the other tabs would think we died and pile a
        // second stream on top of a leader that is working fine.
        claim();
      }
    });
  };

  const closeStream = () => {
    if (!source) return;
    source.close();
    source = null;
  };

  let channel = null;
  try {
    channel = new BroadcastChannel(`state:${scope}`);
  } catch {
    channel = null;
  }

  // No BroadcastChannel (a browser too old to relay): fall back to one stream
  // per tab — the previous behaviour, connection limit and all.
  if (!channel) {
    openStream();
    return () => {
      stopped = true;
      closeStream();
    };
  }

  const readLeader = () => {
    try {
      return JSON.parse(localStorage.getItem(leaderKey) || 'null');
    } catch {
      return null;
    }
  };

  const claim = () => {
    try {
      localStorage.setItem(leaderKey, JSON.stringify({ id: tabId, at: Date.now() }));
    } catch {
      /* storage blocked — the tick below then just keeps re-claiming */
    }
  };

  // Runs on an interval: renew our lease, take over a dead leader, or stand
  // down (closing our stream) when another tab is alive and leading. Two tabs
  // claiming in the same instant is harmless — the next tick reads back a single
  // winner and the other one stands down.
  const tick = () => {
    if (stopped) return;
    const current = readLeader();
    const mine = current?.id === tabId;
    const stale = !current || Date.now() - (current.at || 0) > LEADER_STALE_MS;
    if (mine || stale) {
      claim();
      openStream();
    } else {
      closeStream();
    }
  };

  // Every tab reacts to a vacant lease at once, and a tab that claims it also
  // opens a stream — so racing them all in the same millisecond would briefly
  // open one connection PER TAB, the very thing this whole dance avoids. A short
  // random wait means one tab claims and the rest find a fresh lease and stay
  // followers. Being a few hundred ms late to the stream costs nothing.
  let jitterTimer = null;
  const scheduleTick = (maxDelay) => {
    clearTimeout(jitterTimer);
    jitterTimer = setTimeout(tick, Math.random() * maxDelay);
  };

  const onMessage = (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === 'state') emit(msg.data);
    // The leader is going away: run for the stream now instead of waiting out
    // the staleness window, so a closed tab costs no live updates.
    if (msg.type === 'leader-left') scheduleTick(400);
  };

  // Hand the stream over on close. `pagehide` (not `unload`) is the event that
  // still fires on mobile Safari.
  const release = () => {
    if (readLeader()?.id !== tabId) return;
    try {
      localStorage.removeItem(leaderKey);
    } catch {
      /* nothing we can do; the lease expires on its own */
    }
    try {
      channel.postMessage({ type: 'leader-left' });
    } catch {
      /* channel already closed */
    }
  };

  channel.addEventListener('message', onMessage);
  window.addEventListener('pagehide', release);
  scheduleTick(300); // same anti-stampede jitter for the very first election
  const timer = setInterval(tick, LEADER_HEARTBEAT_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(jitterTimer);
    window.removeEventListener('pagehide', release);
    release();
    closeStream();
    channel.removeEventListener('message', onMessage);
    channel.close();
  };
}
