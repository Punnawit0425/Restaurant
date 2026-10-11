// ---------------------------------------------------------------------------
// Restaurant BACKEND
// ---------------------------------------------------------------------------
// A tiny Express server that owns the *shared* state of the app so that every
// open browser tab (customer + staff + owner) sees the same live data.
//
//   * REST endpoints let a tab READ the full state and WRITE a resource.
//   * A Server-Sent Events (SSE) stream at /api/events PUSHES the latest state
//     to every connected tab the instant anything changes. That is what makes
//     a customer's new order pop up on the staff tab in real time (and the
//     staff's status change show up on the customer tab), even across 2 tabs.
//
// The MENU is read from PostgreSQL (see menu-db.js). The rest of the shared
// state (orders / stock / staff / settings) is persisted to backend/data.json
// so it survives a server restart.
//
// SECURITY MODEL
//   * /api/state and /api/events are public reads, but staff credentials are
//     stripped before they ever leave the server (see sanitizeState).
//   * Passwords are stored hashed (scrypt); plaintext is never persisted.
//   * POST /api/login verifies a password and returns a signed session token.
//     An account the owner created without one cannot be signed into; its person
//     chooses the password at first sign-in via POST /api/login/claim.
//   * Writing menu / staff / settings requires a valid staff token.
//   * Writing `orders` is intentionally public — an unauthenticated customer
//     tab has to be able to place one — but a session-less write can only add
//     lines or ask to เช็กบิล. Every line is re-priced from the server's menu,
//     and a new bill's status and total are derived here (customer-orders.js).
//   * CORS is restricted to configured origins.
// ---------------------------------------------------------------------------

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.js';
import {
  fetchMenuFromDb,
  fetchMenuOptions,
  setDishAvailability,
  setDishTheme,
  setDishOrder,
  ensureMenuOrderColumn,
  insertMenuItem,
  getDishForEdit,
  updateMenuItem,
  deleteMenuItem,
  dishIdentityTaken,
  hasAvailableColumn,
} from './menu-db.js';
import { buildPresetsFromLegacy, validateAddonPresets } from './addon-presets.js';
import { ensureOrdersTable, loadOrders, saveOrders } from './orders-db.js';
import { reconcileCustomerBill, reconcileStaffOrdersWrite, withRoundKeys, dropAbsorbed, numberTakeawayOrders, deriveBillStatus } from './order-merge.js';
import { OrderRejected, cleanCustomerLine, cleanCustomerOrder, cleanCheckoutRequest } from './customer-orders.js';
import { fetchStockItems, fetchStockAvailability, createStockItem, adjustStockItem, setStockItemImage, setStockImageByName, deleteStockItemByName, deleteStockItem, restockAll, consumeStockByName, ensureStockHistoryTable, logStockChange, fetchStockHistory } from './stock-db.js';
import { hashPassword, verifyPassword, isHashed, signToken, verifyToken } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Where runtime state lives. Defaults to the backend folder for local dev; in
// production set DATA_DIR to a mounted persistent volume (e.g. /data) so
// data.json, its backups and the uploaded menu photos survive a redeploy —
// otherwise the container's disk is wiped on every deploy and staff accounts,
// settings and photos are lost.
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PORT = process.env.PORT || 3001;

// Menu photos land here. Created up front so the very first upload has
// somewhere to go on a fresh clone (the folder is gitignored).
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// The menu now lives in PostgreSQL. Warn loudly if it is not configured, but
// keep running on the last-known (seed/persisted) menu so the rest of the app
// still works while someone fixes the connection string.
const HAS_DB = !!(process.env.DATABASE_URL || '').trim();
if (!HAS_DB) {
  console.warn(
    '[backend] DATABASE_URL is not set — the menu cannot be loaded from the ' +
    'database. Add it to backend/.env, e.g. ' +
    'postgres://USER:PASSWORD@localhost:5432/restaurant'
  );
}

// The resources a client is allowed to read/replace.
const RESOURCES = ['orders', 'menu', 'stock', 'staff', 'settings', 'expenses', 'workdays', 'payroll', 'addonPresets', 'menuPresets'];
// Writing any of these requires a valid staff session token. Only `orders` is
// left out, because an unauthenticated customer tab has to be able to place one
// — and even that write is reconciled rather than trusted wholesale (see
// applyPublicOrdersWrite). `expenses` is owner-only bookkeeping.
//
// `stock` used to be public alongside `orders`, on the assumption that a diner
// ordering decrements stock straight from the browser. It does not: the only
// setStock callers are in StaffView, which renders solely for a signed-in staff
// role, and the customer screen reads levels from GET /api/stock-availability.
// So requiring a session here costs the app nothing and takes the shop's whole
// stock table out of reach of anyone who finds the public URL.
const PROTECTED_RESOURCES = new Set(['menu', 'stock', 'staff', 'settings', 'expenses', 'addonPresets', 'menuPresets']);
// A stricter subset of the protected resources that only an *owner* may write:
// staff accounts, shop settings, and the owner's expense bookkeeping. A plain
// staff session is rejected with 403.
const OWNER_RESOURCES = new Set(['staff', 'settings', 'expenses', 'addonPresets', 'menuPresets']);
// Server-owned resources: readable by everyone via /api/state, but never
// replaceable wholesale through PUT — records are only appended/updated by the
// server's own endpoints, so timestamps can't be forged from a browser.
const SERVER_OWNED_RESOURCES = new Set(['workdays', 'payroll']);
// Every access level an account can hold. 'inventory' (ผู้จัดการคลัง) sees only
// คลัง and จัดการเมนู, and in จัดการเมนู only the dishes that have a คลัง row —
// see requireStockedDish and friends below.
const STAFF_ROLES = ['owner', 'staff', 'inventory'];

// --- Load / persist state ---------------------------------------------------
let state;
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  // Make sure every expected key exists (in case seed.js gained new fields).
  for (const key of RESOURCES) {
    if (!(key in state)) state[key] = SEED[key];
  }
  console.log('[backend] Loaded existing state from data.json');
} catch {
  state = structuredClone(SEED);
  console.log('[backend] No data.json found — seeding fresh state');
}
// Open bills carry `roundKeys` so a stale write cannot erase a round it never
// saw — see order-merge.js.
if (Array.isArray(state.orders)) state.orders = dropAbsorbed(state.orders).map(withRoundKeys);
// Owner-typed days worked per staff member per month, keyed "user__YYYY-MM".
// Newer than the seed, so absent on every existing install.
if (!state.workdays || typeof state.workdays !== 'object' || Array.isArray(state.workdays)) {
  state.workdays = {};
}
// Owner-set "paid / not paid" per staff member per month, keyed "user__YYYY-MM".
if (!state.payroll || typeof state.payroll !== 'object' || Array.isArray(state.payroll)) {
  state.payroll = {};
}
// กลุ่มเมนู for the owner's สถิติเมนู table. Newer than the seed, so the resource
// loop above leaves it undefined on every existing install. Unlike addonPresets
// there is nothing to migrate from — the owner builds these by hand or has none.
if (!Array.isArray(state.menuPresets)) state.menuPresets = [];

// One-time migration: fold every extra the app currently offers into editable
// presets (see addon-presets.js). Before this, ตัวเลือกเสริม existed only as
// rows in menu_items that the owner had no screen for; afterwards the same
// extras are owner-owned data attached to dishes by id.
//
// It runs only while `addonPresets` is absent, and only once a menu exists to
// attach them to — a first boot against an empty menu leaves it undefined and
// the call after the next successful sync picks it up. Once the array is there
// (even empty, if the owner deleted every preset) this never fires again, so it
// can never resurrect presets someone deliberately removed.
//
// Returns true when it wrote something, so the caller knows to persist.
function ensureAddonPresets() {
  if (Array.isArray(state.addonPresets)) return false;
  const presets = buildPresetsFromLegacy(state.menu, state.addons, state.choices);
  if (!presets.length) return false;
  state.addonPresets = presets;
  const links = presets.reduce((n, p) => n + p.menuIds.length, 0);
  console.log(
    `[backend] Migrated extras into ${presets.length} preset(s) covering ${links} dish link(s)`
  );
  return true;
}

// One-time migration: any staff account still holding a plaintext `pass` gets
// its password hashed and the plaintext dropped, so credentials never sit on
// disk (or get served to a browser) in the clear again.
//
// The ไอดีพนักงาน (`pin`) is deliberately NOT treated the same way. It is an
// attribution code the owner hands out and is expected to be able to read back
// ("สมชายลืมไอดี เลขอะไรนะ"), which a one-way hash makes impossible — so the
// 4 digits are kept alongside `pinHash` and shown to the owner in the ข้อมูลพนักงาน tab.
// It is still never served to anyone but an owner session (see sanitizeState),
// and it is not a password: signing in needs a real account, and the PIN only
// puts a name on a bill or a discount.
function migrateStaffPasswords() {
  let changed = false;
  for (const s of state.staff || []) {
    if (s && s.pass !== undefined) {
      if (s.pass && !isHashed(s.pass)) s.passHash = hashPassword(s.pass);
      delete s.pass;
      changed = true;
    }
    // A seed/hand-edited account may carry the plaintext code with no hash yet.
    if (s && s.pin !== undefined) {
      const pin = String(s.pin);
      if (pin && !isHashed(pin)) {
        if (!s.pinHash) { s.pinHash = hashPassword(pin); changed = true; }
      } else {
        // A hash that ended up in the `pin` field is not a readable code.
        delete s.pin;
        changed = true;
      }
    }
  }
  if (changed) {
    console.log('[backend] Migrated plaintext staff passwords to scrypt hashes');
  }
}
migrateStaffPasswords();
// Runs against the menu restored from data.json. An install with no menu yet
// gets it after the first successful database sync instead (see syncMenuFromDb).
ensureAddonPresets();

// Rolling backups of data.json. Every persist() snapshots the OUTGOING file
// here before it is replaced, so a bad write (e.g. a stale second server
// instance overwriting good data with an older in-memory copy) is always
// recoverable: the previous good version is sitting in backend/backups.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 40; // most recent snapshots to retain; older ones are pruned
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Copy the current data.json aside, then prune to the newest BACKUP_KEEP files.
// Best-effort: a backup failure must never block or crash the real write.
//
// Rate-limited to one snapshot a minute. copyFileSync, readdirSync and the
// pruning unlinks are all SYNCHRONOUS: running them on every write stalls the
// event loop — and with it every open SSE stream — once per request. On a local
// SSD that is invisible; on a network-backed volume it is milliseconds each
// time, and a single "เสิร์ฟครบทุกจาน" tap fires several writes. Snapshotting on
// a timer instead keeps the recovery story (the previous good version is still
// sitting in backups/) and actually makes the retained window LONGER, since 40
// snapshots now span 40 minutes rather than the last few seconds of traffic.
const BACKUP_MIN_INTERVAL_MS = 60_000;
let lastBackupAt = 0;

function backupCurrentData() {
  if (Date.now() - lastBackupAt < BACKUP_MIN_INTERVAL_MS) return;
  lastBackupAt = Date.now(); // set before the work, so a failure doesn't retry every write
  try {
    if (!fs.existsSync(DATA_FILE)) return; // nothing to snapshot yet (first boot)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `data-${stamp}.json`));

    const backups = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('data-') && f.endsWith('.json'))
      .sort(); // ISO timestamps sort chronologically
    for (const stale of backups.slice(0, -BACKUP_KEEP)) {
      fs.unlinkSync(path.join(BACKUP_DIR, stale));
    }
  } catch (err) {
    console.warn('[backend] Backup snapshot failed (continuing):', err.message);
  }
}

// Write to a temp file first, then rename over the real one. rename() is
// atomic, so a process that dies mid-write leaves data.json either fully old or
// fully new — never the half-written file that JSON.parse rejects on the next
// boot (which silently reseeds and loses the day's orders).
function persist() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFile(tmp, JSON.stringify(state, null, 2), (err) => {
    if (err) return console.error('[backend] Failed to write data.json:', err);
    // Snapshot the current (about-to-be-replaced) file first, so the last good
    // state survives even if this write turns out to carry stale data.
    backupCurrentData();
    fs.rename(tmp, DATA_FILE, (renameErr) => {
      if (renameErr) console.error('[backend] Failed to replace data.json:', renameErr);
    });
  });
}
persist();

// Mirror the orders array into Postgres. data.json stays as a local backup, but
// the database is the copy that matters: it survives a corrupt file, can be
// backed up with pg_dump, and can be queried directly in pgAdmin.
//
// Failures are logged, never thrown — orders-db.js only marks a row as saved
// once the write succeeds, so the next save retries whatever did not land.
let ordersWriteInFlight = false;
let ordersWriteQueued = false;

async function persistOrdersToDb() {
  if (!HAS_DB) return;
  // Collapse a burst of writes into one follow-up pass instead of queueing a
  // round trip per request.
  if (ordersWriteInFlight) {
    ordersWriteQueued = true;
    return;
  }
  ordersWriteInFlight = true;
  try {
    const saved = await saveOrders(state.orders);
    if (saved) console.log(`[backend] Saved ${saved} order(s) to PostgreSQL`);
  } catch (err) {
    console.warn(`[backend] Could not save orders to PostgreSQL, will retry on next write. (${err.message})`);
  } finally {
    ordersWriteInFlight = false;
    if (ordersWriteQueued) {
      ordersWriteQueued = false;
      persistOrdersToDb();
    }
  }
}

// A copy of the state that is safe to send to a browser: staff objects keep
// their username and display name but never their password hash.
// The view of the shared state a given caller is allowed to see. `session` is
// the verified token payload ({ user, ... }) or null. Access level is read from
// the LIVE staff record (not the token) so a demoted account loses access at
// once. Three tiers:
//   * public / customer (no session): storefront data only — menu, stock,
//     orders, settings, addons, choices.
//   * any signed-in staff: the same storefront data.
//   * owner: everything, including staff HR (wages/positions), the expense book,
//     days worked and payroll.
// Password material is stripped for everyone. This is what stops a diner on the
// shop WiFi from reading salaries/expenses off the public /api/state.
function sanitizeState(s, session = null) {
  const account = session && (s.staff || []).find((a) => a.user === session.user);
  const isOwner = account?.role === 'owner';
  // `timeclock` is what the removed ลงเวลาเข้า-ออกงาน feature left in data.json.
  // It stays on disk as an archive but is never served to anyone.
  const { timeclock, ...rest } = s;
  return {
    ...rest,
    // Password material never leaves the server — not even for the owner.
    //
    // The ไอดีพนักงาน does, but only on an owner session: the owner is the person
    // who assigns the codes and has to be able to read one back to whoever
    // forgot it, so the ข้อมูลพนักงาน tab shows the 4 digits. `hasPin` still rides along —
    // an account with no code cannot sign a bill, and one whose code predates
    // this (hash only, nothing readable) shows as ตั้งใหม่ rather than blank.
    staff: isOwner
      ? (s.staff || []).map(({ passHash, pass, pinHash, pin, ...rest }) => ({
          ...rest,
          hasPin: !!pinHash,
          pin: pin ? String(pin) : '',
          // An account the owner created without a password is waiting for its
          // person to choose one at first sign-in. The owner's screen says so,
          // because until then nobody can get into it.
          hasPass: !!passHash,
        }))
      : [],
    expenses: isOwner ? s.expenses : [],
    workdays: isOwner ? s.workdays : {},
    payroll: isOwner ? s.payroll : {},
  };
}

// --- Real-time (SSE) broadcasting ------------------------------------------
// Each client is { res, session } so every open stream is sent only the slice
// of state its session is allowed to see (see sanitizeState). One customer and
// one owner on the same broadcast get different payloads.
const clients = new Set();

function broadcast() {
  for (const client of clients) {
    const payload = `event: state\ndata: ${JSON.stringify(sanitizeState(state, client.session))}\n\n`;
    client.res.write(payload);
  }
}

// --- Live menu sync from PostgreSQL ----------------------------------------
// Pull the latest menu and adopt it as the source of truth. The database owns
// the menu outright — day, night and both — so whatever it returns IS the menu.
// The dishes in seed.js are a cold-start fallback for an install whose
// menu_items table is still empty, and nothing more.
//
// Per-item "available" toggles set by the owner in the app survive a sync,
// keyed by the item's stable id.
async function syncMenuFromDb() {
  const { menu: dbMenu, addons: dbAddons, choices: dbChoices } = await fetchMenuFromDb();
  // Once menu_items carries an `available` column the DATABASE owns the on/off
  // switch, and the value it supplies must win — re-applying the previous
  // in-memory flag here would mask every toggle the owner makes and make the
  // switch look broken. Until the column is added there is nowhere to store it,
  // so the old in-memory behaviour is kept rather than resetting dishes to "on"
  // on every sync.
  const dbOwnsAvailable = await hasAvailableColumn();
  const prevAvailById = dbOwnsAvailable
    ? new Map()
    : new Map((state.menu || []).map((m) => [m.id, m.available]));
  // A dish the database does not have is not on the menu — full stop.
  //
  // This used to keep, alongside dbMenu, every state.menu item whose `theme` the
  // database no longer supplied, so that a hand-seeded shift menu survived until
  // its rows were imported. That rule cannot tell "never imported" from "just
  // deleted": removing the LAST dish of a shift (or the last 'both' dish) took
  // that theme out of the database's set, and the copy still sitting in
  // state.menu was read as hand-seeded and put straight back — then persisted,
  // so the dish returned on every restart and could never be deleted again. The
  // same trap had already been patched once for theme 'none'.
  //
  // The seeded dishes are now what they actually are: a fallback for a table
  // with nothing in it. A database that answers with dishes replaces the menu
  // entirely; one that cannot be reached throws before this line, leaving the
  // last known menu untouched.
  const manualItems = dbMenu.length ? [] : (SEED.menu || []);
  const nextMenu = [
    ...dbMenu.map((item) =>
      prevAvailById.has(item.id)
        ? { ...item, available: prevAvailById.get(item.id) }
        : item
    ),
    ...manualItems,
  ];
  // Same rule for the extras, but an EMPTY bucket from the database never wins:
  // before a shift's rows are imported its lists come back [], and letting that
  // overwrite the seeded extras would silently empty that storefront.
  //
  // The buckets are now nested one level per shift — { day: { food, drink },
  // night: { food, drink } } — so the walk recurses. The flat legacy shape is
  // still merged correctly by the same code, which is what lets stored state
  // written before the split survive until the next sync rewrites it.
  const mergeBuckets = (current, incoming) => {
    const out = { ...(current || {}) };
    for (const [bucket, list] of Object.entries(incoming || {})) {
      if (Array.isArray(list)) {
        if (list.length) out[bucket] = list;
      } else if (list && typeof list === 'object') {
        out[bucket] = mergeBuckets(out[bucket], list);
      }
    }
    return out;
  };
  const nextAddons = mergeBuckets(state.addons, dbAddons);
  const nextChoices = mergeBuckets(state.choices, dbChoices);

  // Only touch state when something actually differs, so the poll below stays
  // silent (no disk write, no SSE push) while the database is untouched.
  const changed =
    JSON.stringify(state.menu) !== JSON.stringify(nextMenu) ||
    JSON.stringify(state.addons) !== JSON.stringify(nextAddons) ||
    JSON.stringify(state.choices) !== JSON.stringify(nextChoices);
  if (changed) {
    state.menu = nextMenu;
    state.addons = nextAddons;
    state.choices = nextChoices;
  }
  // First sync on an install whose menu was empty at boot is where the preset
  // migration finally has dishes to attach to, so it gets its chance here too.
  const migrated = ensureAddonPresets();
  if (changed || migrated) persist();
  return { count: nextMenu.length, changed: changed || migrated };
}

// Re-pull the database on a timer so an edit made directly in Postgres (e.g. in
// pgAdmin) reaches every open tab on its own. A local DB query is cheap, so a
// short interval is fine here.
const SYNC_INTERVAL_SEC = Number(process.env.MENU_SYNC_INTERVAL_SECONDS || 30);

function startMenuPolling() {
  if (!HAS_DB || !(SYNC_INTERVAL_SEC > 0)) {
    console.log('[backend] Menu auto-sync disabled');
    return;
  }
  let running = false; // never let a slow query overlap itself
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { count, changed } = await syncMenuFromDb();
      if (changed) {
        broadcast();
        console.log(`[backend] Database changed — menu updated (${count} items)`);
      }
    } catch (err) {
      // A transient failure is not fatal: the last-known menu stays live and
      // the next tick will try again.
      console.warn(`[backend] Menu auto-sync failed, keeping current menu. (${err.message})`);
    } finally {
      running = false;
    }
  }, SYNC_INTERVAL_SEC * 1000);
  console.log(`[backend] Menu auto-sync every ${SYNC_INTERVAL_SEC}s`);
}

// --- App --------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

// Behind Railway/Fly the app never sees the caller directly — every request
// arrives from the platform's router, so req.ip would be that one proxy address
// for everybody. The login rate limiter keys on req.ip, and without this line it
// would put the whole shop in a single bucket: ten wrong passwords from anyone
// on the internet would lock out every real member of staff for 15 minutes,
// while an attacker spreading attempts would never be limited at all.
//
// One hop is exactly right: trusting the single proxy in front of us makes
// req.ip the left-most address the platform appends to X-Forwarded-For. Trusting
// more hops (or `true`) would let a client forge the header and dodge the limit.
// Locally there is no proxy, so this changes nothing in dev.
app.set('trust proxy', 1);

// CORS: only allow the origins we expect the app to be served from. Configure
// extra ones (e.g. your deployed URL) via ALLOWED_ORIGINS, comma-separated.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// The app is served to phones/tablets over the shop's LAN (and the LAN IP
// changes per network), so besides the fixed list also accept any localhost
// or RFC-1918 private-network origin on any port. Public internet origins
// are still rejected.
const PRIVATE_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

app.use(cors({
  origin(origin, cb) {
    // Same-origin / curl / server-to-server requests have no Origin header.
    if (!origin || ALLOWED_ORIGINS.includes(origin) || PRIVATE_ORIGIN_RE.test(origin)) {
      return cb(null, true);
    }
    cb(new Error(`Origin not allowed by CORS: ${origin}`));
  },
}));

// Minimal security headers (avoids pulling in helmet as a dependency).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '2mb' }));

// --- Auth helpers -----------------------------------------------------------

// Pull "Authorization: Bearer <token>" off a request and verify it. Returns the
// token payload ({ user, exp }) or null.
function getSession(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  return verifyToken(match[1]);
}

// A caller that SENT a token we cannot verify (expired, or signed with another
// AUTH_SECRET) is a staff tab whose session lapsed — not a customer. The order
// routes used to fall through to the public path for it, which reconciles a
// payment away (a diner cannot close a bill), so the write "succeeded" and the
// bill stayed open. Answering 401 instead makes the tab sign in again.
function hasUnverifiedToken(req) {
  return !!req.get('authorization') && !getSession(req);
}

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.session = session;
  next();
}

// Owner-only guard. The role is read from the *current* staff record (not just
// the token) so an account demoted from owner loses access immediately, even on
// a token that was signed while it was still an owner.
function requireOwner(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const account = (state.staff || []).find((s) => s.user === session.user);
  if (!account || account.role !== 'owner') {
    return res.status(403).json({ error: 'ต้องเป็นเจ้าของร้านเท่านั้น' });
  }
  req.session = session;
  next();
}

// --- ผู้จัดการคลัง scope ------------------------------------------------------
// An inventory manager may edit a dish only when it has a คลัง row. The link is
// by name under LOWER(TRIM), the same rule consumeStockByName uses, so what
// counts as "in stock" here is exactly what the rest of the system treats as
// linked. Like requireOwner, the role is read from the live staff record.
const stockKey = (name) => String(name || '').trim().toLowerCase();

function isInventoryManager(req) {
  const account = (state.staff || []).find((s) => s.user === req.session?.user);
  return account?.role === 'inventory';
}

async function stockedNames() {
  return new Set((await fetchStockAvailability()).map((i) => stockKey(i.name)));
}

const OUT_OF_SCOPE = 'ผู้จัดการคลังแก้ไขได้เฉพาะเมนูที่อยู่ในคลังเท่านั้น';

// For the routes that name one dish by id (in :id or body.id). Runs after
// requireAuth. Everyone else passes straight through.
async function requireStockedDish(req, res, next) {
  if (!isInventoryManager(req)) return next();
  const id = String(req.params.id || req.body?.id || '').trim();
  const dish = (state.menu || []).find((m) => m.id === id);
  try {
    if (dish && !(await stockedNames()).has(stockKey(dish.name))) {
      return res.status(403).json({ error: OUT_OF_SCOPE });
    }
  } catch (err) {
    console.error('[backend] Could not read stock_items for the scope check:', err.message);
    return res.status(502).json({ error: 'อ่านคลังวัตถุดิบจากฐานข้อมูลไม่สำเร็จ' });
  }
  next();
}

// Very small in-memory rate limiter for the login endpoint, so the password
// hash can't be brute-forced from a single IP. Not a substitute for a real
// WAF, but stops the trivial case.
const loginAttempts = new Map(); // ip -> { count, first }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginRateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > LOGIN_MAX_ATTEMPTS;
}

// --- Menu photo uploads -----------------------------------------------------
// Accepting a file from a browser is a classic foothold, so the rules are
// deliberately narrow:
//
//   * The server names every file itself (UUID + an extension derived from the
//     allowed MIME type). A client-supplied filename is never touched, which is
//     what makes "../../etc/passwd" a non-event rather than a path traversal.
//   * Only the three image types the app can display are accepted.
//   * 5 MB cap and exactly one file per request, so an upload cannot fill the
//     disk in a single call.
//
// The browser already shrinks photos to <=1200px JPEG before sending (see
// OwnerView), so a real menu photo arrives at ~200KB and the server never needs
// an image library to process it.
const UPLOAD_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) =>
      cb(null, `${crypto.randomUUID()}${UPLOAD_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (UPLOAD_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('รองรับเฉพาะไฟล์ภาพ JPEG, PNG หรือ WebP เท่านั้น'));
  },
});

// Serve the stored photos. `image_url` holds a root-relative path
// (/uploads/xxx.jpg) rather than an absolute URL, so the same value works from
// the Vite dev server (which proxies /uploads through to here) and from a
// production deploy without a hardcoded host in the database.
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  index: false,
  // Filenames are server-generated UUIDs, so a request for anything else is
  // someone probing — 404 immediately instead of falling through.
  fallthrough: true,
}));

// --- Routes -----------------------------------------------------------------

// Snapshot of the shared state, scoped to the caller's access (Bearer token).
app.get('/api/state', (req, res) => {
  res.json(sanitizeState(state, getSession(req)));
});

// Live stream: sends the current state on connect, then again on every change.
// EventSource cannot set an Authorization header, so the session token rides as
// a ?token= query param. Absent/invalid ⇒ the public view (customers connect
// here too), never a rejection.
app.get('/api/events', (req, res) => {
  const session = verifyToken(String(req.query.token || '')) || null;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Tell any reverse proxy in front of us (Railway's edge, nginx) not to
    // buffer this response. A buffered stream holds pushes back and then
    // delivers them in a lump, which reads as the board jumping rather than
    // updating. There is no proxy in dev, which is why it only ever showed up
    // in production.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: state\ndata: ${JSON.stringify(sanitizeState(state, session))}\n\n`);
  // Comment ping keeps proxies/browsers from closing an idle connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  const client = { res, session };
  clients.add(client);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
});

// The signed session + public profile handed back on a successful sign-in. The
// token carries the role/shop so the frontend can route straight to the right
// panel; owner-only endpoints re-check the role against the live record.
function sessionFor(account) {
  const role = STAFF_ROLES.includes(account.role) ? account.role : 'staff';
  const shop = account.shop === 'night' ? 'night' : 'day';
  return {
    token: signToken({ user: account.user, role, shop }),
    user: account.user,
    name: account.name,
    role,
    shop,
    position: account.position || '',
  };
}

// Staff login. Verifies the password against the stored hash and, on success,
// returns a signed session token plus the staff member's public profile.
// An account the owner left without a password answers `mustSetPassword`
// instead — see POST /api/login/claim below.
app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }

  const user = String(req.body?.user || '').trim();
  const pass = String(req.body?.pass || '');
  const account = (state.staff || []).find((s) => s.user === user);

  // Always run a verify (even for an unknown user) to avoid leaking which
  // usernames exist via response timing.
  const ok = account
    ? verifyPassword(pass, account.passHash)
    : verifyPassword(pass, 'scrypt$0$00');

  // An account the owner created without a password cannot be signed into —
  // there is nothing to verify against, and `ok` above is false for it whatever
  // was typed. Instead of "รหัสผ่านไม่ถูกต้อง" (which would send this person to
  // ask the owner for a password that was never set), say what is actually true
  // and let the browser move on to claiming it. No token is issued here.
  if (account && !account.passHash) {
    return res.json({ mustSetPassword: true, user: account.user, name: account.name });
  }

  if (!ok || !account) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }

  res.json(sessionFor(account));
});

// Claim a password-less account by choosing its password — the second half of
// the flow above, and the ONLY way an account with no hash becomes usable.
//
// It is not a password reset: an account that already has one is refused (409),
// so this cannot be pointed at a colleague's live account to take it over. What
// it does mean is that a brand-new account is claimable by whoever knows the
// username until its person gets to it, which is the trade the owner makes by
// not setting a password — the same trade as writing "1234" on a note. Rate
// limited on the same counter as login, so the usernames cannot be walked.
app.post('/api/login/claim', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: 'ลองใหม่มากเกินไป กรุณารอสักครู่' });
  }

  const user = String(req.body?.user || '').trim();
  const pass = String(req.body?.pass || '');
  const account = (state.staff || []).find((s) => s.user === user);

  if (!account) return res.status(404).json({ error: 'ไม่พบชื่อผู้ใช้นี้' });
  if (account.passHash) {
    return res.status(409).json({ error: 'บัญชีนี้ตั้งรหัสผ่านไว้แล้ว — เข้าสู่ระบบด้วยรหัสผ่านเดิม' });
  }
  if (pass.length < 4) return res.status(400).json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 4 ตัวอักษร' });
  if (pass.length > 200) return res.status(400).json({ error: 'รหัสผ่านยาวเกินไป' });

  account.passHash = hashPassword(pass);
  persist();
  broadcast(); // the owner's staff list flips to "ตั้งรหัสผ่านแล้ว" straight away
  console.log(`[backend] Staff account "${account.user}" claimed — password set at first sign-in`);

  // Signed straight in: making them retype what they just chose adds nothing.
  res.json(sessionFor(account));
});

// --- ไอดีพนักงาน (staff PIN) ------------------------------------------------
// A 4-digit code the owner assigns to each person. It is NOT a password: it
// opens no session and unlocks no screen. It signs an ACTION — printing a bill,
// granting a discount — with the name of whoever was actually standing at the
// till, so those cannot be done under someone else's name.
//
// Three properties make that hold:
//   * always CHECKED against the scrypt hash, never against the stored digits;
//   * shown to nobody but an owner session — a staff panel is not given the
//     staff list at all (see sanitizeState), so a device at the till cannot look
//     up a colleague's code to sign a bill as them. The owner can read the
//     digits, which is the point: they issue the codes. The trade is that
//     data.json (and its backups) now hold them in the clear, so that file is as
//     sensitive as the till itself;
//   * unique across accounts, or "whose PIN is this" would have two answers.
const PIN_RE = /^\d{4}$/;

// The account a typed PIN belongs to, or null. Scans every account because the
// hash is salted per record — fine for a shop-sized staff list.
function findStaffByPin(pin, staffList = state.staff) {
  if (!PIN_RE.test(String(pin || ''))) return null;
  return (staffList || []).find((s) => s.pinHash && verifyPassword(String(pin), s.pinHash)) || null;
}

// Is this PIN already somebody else's? `exceptUser` is the account being edited,
// which is allowed to keep its own code.
function pinTakenBy(pin, exceptUser) {
  const owner = findStaffByPin(pin);
  return owner && owner.user !== exceptUser ? owner : null;
}

// Reduce the incoming staff array to safe, hashed records. New accounts must
// carry a plaintext `pass`; existing accounts (which arrive without one, since
// the served state omits it) keep their stored hash. Throws on invalid input.
function normalizeStaffWrite(incoming) {
  if (!Array.isArray(incoming)) throw new Error('staff must be an array');
  const existingByUser = new Map((state.staff || []).map((s) => [s.user, s]));
  const out = [];
  // Plaintext PINs set inside THIS write, so two accounts added in one go can't
  // be given the same code (the stored hashes can't catch that — they are only
  // written at the end).
  const pinsInBatch = new Map();
  for (const raw of incoming) {
    const user = String(raw?.user || '').trim();
    const name = String(raw?.name || '').trim() || user;
    if (!user) throw new Error('every staff member needs a username');
    const existing = existingByUser.get(user);

    let passHash;
    if (raw.pass) {
      passHash = hashPassword(String(raw.pass));           // new / changed password
    } else if (isHashed(raw.passHash)) {
      passHash = raw.passHash;                             // client echoed a hash
    } else {
      passHash = existing?.passHash;                       // preserve stored hash
    }
    // No password is a legitimate state, not an error: the owner can hand out an
    // account and let the person choose their own password the first time they
    // sign in (see POST /api/login/claim). Until they do, the account holds no
    // hash and NOTHING accepts it — /api/login refuses to issue a token for it.

    // HR fields entered by the owner (ตำแหน่ง / ค่าแรงรายวัน / ร้านที่ประจำ).
    // Sanitised to plain scalars; missing values fall back to the stored record
    // so a client that omits them doesn't wipe them.
    const position = String(raw?.position ?? existing?.position ?? '').trim().slice(0, 100);
    const dailyWage = Math.max(0, Number(raw?.dailyWage ?? existing?.dailyWage) || 0);
    const shop = ['day', 'night'].includes(raw?.shop) ? raw.shop : (existing?.shop || 'day');
    // Access level: 'owner' (เจ้าของ — back-office panel) | 'staff' (พนักงาน —
    // shift board only) | 'inventory' (ผู้จัดการคลัง — คลัง + the stocked slice of
    // จัดการเมนู only). Defaults to 'staff' so a new account is never
    // accidentally granted owner access.
    const role = STAFF_ROLES.includes(raw?.role) ? raw.role : (existing?.role || 'staff');

    // ไอดีพนักงาน: 4 digits, set by the owner. Absent means "leave it alone",
    // so a form that doesn't touch the PIN never wipes it. The digits are stored
    // as well as hashed — the owner's screen reads them back (see sanitizeState),
    // while every check still goes through the hash.
    let pinHash = existing?.pinHash;
    let pinPlain = existing?.pin ? String(existing.pin) : '';
    // The owner's screen now receives the code, so an untouched account echoes
    // its own PIN straight back. Recognise that and keep the stored hash: both
    // re-hashing and the uniqueness scan below are scrypt work per account, and
    // paying it for every row on every staff write would stall the save.
    const unchangedPin = pinPlain && String(raw?.pin ?? '').trim() === pinPlain;
    if (!unchangedPin && raw?.pin != null && String(raw.pin).trim() !== '') {
      const pin = String(raw.pin).trim();
      if (!PIN_RE.test(pin)) throw new Error(`ไอดีพนักงานของ "${user}" ต้องเป็นตัวเลข 4 หลัก`);
      const clash = pinsInBatch.get(pin) ?? pinTakenBy(pin, user)?.name;
      if (clash) throw new Error(`ไอดี ${pin} ถูกใช้โดย "${clash}" แล้ว — เลือกเลขอื่น`);
      pinsInBatch.set(pin, name);
      pinHash = hashPassword(pin);
      pinPlain = pin;
    }

    out.push({
      user, name, position, dailyWage, shop, role,
      ...(passHash ? { passHash } : {}),
      ...(pinHash ? { pinHash } : {}),
      ...(pinPlain ? { pin: pinPlain } : {}),
    });
  }
  if (!out.length) throw new Error('at least one staff account is required');
  return out;
}

// Lightweight shape/size checks so a public `orders` write (or a buggy client)
// can't corrupt the store or blow up memory.
function validateResourceBody(resource, body) {
  switch (resource) {
    case 'orders':
      if (!Array.isArray(body)) return 'orders must be an array';
      if (body.length > 5000) return 'too many orders';
      if (!body.every((o) => o && typeof o === 'object' && !Array.isArray(o))) {
        return 'each order must be an object';
      }
      return null;
    case 'menu':
      return Array.isArray(body) ? null : 'menu must be an array';
    case 'expenses':
      if (!Array.isArray(body)) return 'expenses must be an array';
      if (body.length > 20000) return 'too many expenses';
      if (!body.every((e) => e && typeof e === 'object' && !Array.isArray(e))) {
        return 'each expense must be an object';
      }
      return null;
    case 'addonPresets':
      return validateAddonPresets(body);
    // กลุ่มเมนู for the owner's สถิติเมนู table: one named list of dish ids, and
    // nothing else. Unlike addonPresets these change nothing about how a dish is
    // ordered — they only decide which rows the stats table shows.
    case 'menuPresets': {
      if (!Array.isArray(body)) return 'menuPresets must be an array';
      if (body.length > 200) return 'too many menu presets';
      for (const p of body) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return 'each preset must be an object';
        if (!p.id || typeof p.id !== 'string') return 'each preset needs an id';
        if (typeof p.name !== 'string' || !p.name.trim()) return 'each preset needs a name';
        if (!Array.isArray(p.menuIds) || p.menuIds.length > 5000) return 'menuIds must be a list';
        if (!p.menuIds.every((id) => typeof id === 'string')) return 'menuIds must be dish ids';
      }
      return null;
    }
    case 'stock':
    case 'settings':
      return body && typeof body === 'object' && !Array.isArray(body)
        ? null : `${resource} must be an object`;
    default:
      return null;
  }
}

// --- Public order writes ----------------------------------------------------
// A customer tab has no session, yet it has to be able to write `orders`: the
// whole ordering flow is "take the array you were pushed, change it, PUT it
// back". Taking that array at face value from an unauthenticated caller means
// `PUT /api/orders` with `[]` erases the day's sales from anywhere on the
// internet — survivable on the shop LAN, not on a public URL.
//
// So a session-less write is treated as a PROPOSAL, not a replacement. The
// server rebuilds the array itself:
//
//   * every order it already has stays, in its existing position — a deletion
//     is simply not expressible, so the wipe above is a no-op;
//   * an order that is already paid or cancelled keeps the SERVER's copy, so
//     settled bills and the revenue they represent cannot be rewritten;
//   * an open bill takes the tab's version, which is what legitimately changes:
//     mergeOrder folding a new round into this table's bill, or เช็กบิล being
//     stamped on it;
//   * anything the tab carries that the server has never seen is appended as a
//     genuinely new order.
//
// A signed-in staff or owner tab bypasses all of this and writes the array
// directly — voiding a bill or correcting history is their job.
//
// A pleasant side effect: this also fixes a race that could previously lose a
// write. If staff marked a bill paid while a diner was composing an order, that
// diner's tab would PUT its slightly stale array and quietly revert the bill to
// unpaid. Now the server's copy of a closed bill always wins.
// A diner's tab introduces exactly one order when it places one, and none when
// it only stamps เช็กบิล. A few spare covers a double-tap or two tablets at one
// table; past that it is someone stuffing the order book, which reconciliation
// alone would happily accumulate. Staff sessions are not bound by this.
const MAX_NEW_PUBLIC_ORDERS = 5;

// Returns { orders } with the reconciled array, or { error, status } to reject
// with. Every line a diner adds, and every bill they open, is rebuilt from the
// server's menu first (customer-orders.js) — prices, status and total included.
function applyPublicOrdersWrite(next, prev) {
  try {
    return reconcilePublicOrders(next, prev);
  } catch (err) {
    if (err instanceof OrderRejected) return { error: err.message, status: 400 };
    throw err;
  }
}

function reconcilePublicOrders(next, prev) {
  const menuCtx = {
    menu: state.menu,
    addonPresets: state.addonPresets,
    addons: state.addons,
    choices: state.choices,
  };
  const cleanLine = (line) => cleanCustomerLine(line, menuCtx);

  // Orders are identified by `id` (client-generated, e.g. 'B' + time + random;
  // mergeOrder preserves it when folding a new round into an open bill). An
  // order without one can never be matched to a stored order, so it is only ever
  // treated as new — it can never overwrite something that already exists.
  const idOf = (o) => (o && typeof o.id === 'string' && o.id ? o.id : null);

  const incoming = new Map();
  for (const o of next) {
    const id = idOf(o);
    // First occurrence wins; a repeated id in one payload is a duplicate, not a
    // second bill, and must not be able to shadow the stored order twice.
    if (id !== null && !incoming.has(id)) incoming.set(id, o);
  }

  const matched = new Set();
  const merged = prev.map((before) => {
    const id = idOf(before);
    const after = id === null ? undefined : incoming.get(id);
    if (after) matched.add(id);
    const closed = before.status === 'paid' || before.status === 'cancelled';
    // Closed bill: the server's copy is the sales record and always wins.
    // Missing from the payload: kept, so a deletion cannot be expressed.
    // Open bill the tab also has: take only what a diner can change — a new
    // round, or เช็กบิล — on top of the server's copy (order-merge.js).
    return closed || !after
      ? before
      : reconcileCustomerBill(before, after, cleanLine, cleanCheckoutRequest);
  });

  // Both places that open a bill mint an id, so an id-less entry is not a new
  // order — it is an older tab echoing back a stored bill it cannot name, and
  // appending it would only duplicate that bill.
  const fresh = next.filter((o) => {
    const id = idOf(o);
    return id !== null && !matched.has(id);
  });
  if (fresh.length > MAX_NEW_PUBLIC_ORDERS) {
    return { error: 'too many new orders in one write', status: 403 };
  }
  // A takeaway session id is only ever a short token the phone minted; anything
  // else is dropped rather than stored, since it decides which bill later
  // orders from that phone land on.
  const cleaned = fresh.map((o) => {
    const ok = typeof o.takeawaySession === 'string' && /^[A-Za-z0-9]{1,40}$/.test(o.takeawaySession);
    const { takeawaySession, ...rest } = o;
    return cleanCustomerOrder(ok ? o : rest, menuCtx, deriveBillStatus);
  });
  // New กลับบ้าน bills get their number from the server (see order-merge.js).
  const added = numberTakeawayOrders(cleaned, merged).map(withRoundKeys);

  return { orders: [...merged, ...added] };
}

// Replace a single resource, then tell everyone about the new state.
// Protected resources (menu/stock/staff/settings) require a valid session;
// `orders` is public so customers can place them — reconciled, not trusted.
app.put('/api/:resource', (req, res) => {
  const { resource } = req.params;
  if (!RESOURCES.includes(resource)) {
    return res.status(404).json({ error: `Unknown resource: ${resource}` });
  }

  if (hasUnverifiedToken(req)) {
    return res.status(401).json({ error: 'Session expired' });
  }

  if (SERVER_OWNED_RESOURCES.has(resource)) {
    return res.status(403).json({ error: `${resource} can only be changed through its own endpoint` });
  }

  if (PROTECTED_RESOURCES.has(resource) && !getSession(req)) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Editing staff accounts or shop settings is an owner-only action, even though
  // both are "protected" resources a plain staff session could otherwise write.
  if (OWNER_RESOURCES.has(resource)) {
    const session = getSession(req);
    const account = session && (state.staff || []).find((s) => s.user === session.user);
    if (!account || account.role !== 'owner') {
      return res.status(403).json({ error: 'ต้องเป็นเจ้าของร้านเท่านั้น' });
    }
  }

  if (resource === 'staff') {
    try {
      state.staff = normalizeStaffWrite(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  } else {
    const problem = validateResourceBody(resource, req.body);
    if (problem) return res.status(400).json({ error: problem });

    // `orders` is the one resource a session-less tab may write. Reconcile that
    // proposal against what we already hold instead of replacing outright. A
    // signed-in staff/owner tab may void or correct anything, but its write is
    // still reconciled so a stale copy cannot drop a bill or a round that
    // arrived after it last updated (order-merge.js).
    if (resource === 'orders' && !getSession(req)) {
      const { orders, error, status } = applyPublicOrdersWrite(req.body, state.orders || []);
      if (error) return res.status(status || 403).json({ error });
      state.orders = orders;
    } else if (resource === 'orders') {
      state.orders = reconcileStaffOrdersWrite(req.body, state.orders || []);
    } else {
      state[resource] = req.body;
    }
  }

  persist();
  // Sales data additionally goes to Postgres, which is its real home. This is
  // deliberately not awaited: the write is already safe in memory + data.json,
  // and a slow or briefly unreachable database must never stall the tab that
  // is trying to take an order.
  if (resource === 'orders') persistOrdersToDb();
  broadcast();
  res.json({ ok: true });
});

// Write only the bills that changed: { changed: [bill, ...] }. Saving `orders`
// used to PUT the whole array, paid history and all, and that only grows — once
// it passed the 2 MB body limit every save was refused with 413 while the tab
// carried on as if it had worked. A tap touches one or two bills, so that is all
// a tab sends now.
//
// The full array is rebuilt here from the server's own copy — each changed bill
// replaced in place by id, an id never seen before appended, bills folded away
// by รวมบิล dropped as a full write would drop them — and then goes through the
// same reconciliation as PUT, so the two paths cannot disagree about what a
// write may do. PUT stays for tabs still running an older build.
const MAX_CHANGED_ORDERS = 200;

app.patch('/api/orders', (req, res) => {
  if (hasUnverifiedToken(req)) {
    return res.status(401).json({ error: 'Session expired' });
  }

  const changed = req.body?.changed;
  const problem = validateResourceBody('orders', changed);
  if (problem) return res.status(400).json({ error: problem });
  if (changed.length > MAX_CHANGED_ORDERS) {
    return res.status(400).json({ error: 'too many changed orders' });
  }
  // A bill is matched by id, so one without an id cannot say which bill it
  // replaces. Both places that create a bill mint one.
  if (!changed.every((o) => typeof o.id === 'string' && o.id)) {
    return res.status(400).json({ error: 'each changed order needs an id' });
  }

  const prev = state.orders || [];
  const byId = new Map();
  for (const o of changed) {
    // First occurrence wins, as in applyPublicOrdersWrite.
    if (!byId.has(o.id)) byId.set(o.id, o);
  }
  const placed = new Set();
  const replaced = prev.map((o) => {
    // Only the first stored bill with an id is replaced, so two bills that
    // happen to share one never collapse into identical copies.
    if (!o?.id || !byId.has(o.id) || placed.has(o.id)) return o;
    placed.add(o.id);
    return byId.get(o.id);
  });
  const added = [...byId.values()].filter((o) => !placed.has(o.id));
  const next = dropAbsorbed([...replaced, ...added]);

  if (getSession(req)) {
    state.orders = reconcileStaffOrdersWrite(next, prev);
  } else {
    // A stored bill without an id is kept by applyPublicOrdersWrite from `prev`
    // already; passing it again would read as a new order and duplicate it.
    const { orders, error, status } = applyPublicOrdersWrite(next.filter((o) => o?.id), prev);
    if (error) return res.status(status || 403).json({ error });
    state.orders = orders;
  }

  persist();
  persistOrdersToDb();
  broadcast();
  res.json({ ok: true });
});

// Owner sets a staff member's monthly payroll status ('paid' | 'unpaid').
// Keyed "user__YYYY-MM". Auth required.
app.post('/api/payroll/status', requireOwner, (req, res) => {
  const user = String(req.body?.user || '').trim();
  const month = String(req.body?.month || '').trim();
  const status = req.body?.status === 'paid' ? 'paid' : 'unpaid';
  if (!user) return res.status(400).json({ error: 'missing user' });
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'รูปแบบเดือนไม่ถูกต้อง' });

  // An owner account is not on the payroll — เจ้าของร้าน is the one paying, so
  // there is no wage of theirs to settle. The UI leaves them out of the table
  // entirely; this stops a stale tab or a hand-made request filing one anyway.
  const target = (state.staff || []).find((a) => a.user === user);
  if (target?.role === 'owner') {
    return res.status(400).json({ error: 'บัญชีเจ้าของร้านไม่มีเงินเดือนให้จ่าย' });
  }

  const key = `${user}__${month}`;
  if (status === 'paid') state.payroll[key] = 'paid';
  else delete state.payroll[key]; // absent = unpaid, keeps the store small

  persist();
  broadcast();
  res.json({ ok: true });
});

// Owner records how many days a staff member worked in a month. Keyed
// "user__YYYY-MM"; 0 removes the entry (absent = 0 days, keeps the store small).
// The salary is days × ค่าแรง/วัน, computed on the owner's screen.
app.post('/api/payroll/days', requireOwner, (req, res) => {
  const user = String(req.body?.user || '').trim();
  const month = String(req.body?.month || '').trim();
  const days = Number(req.body?.days);
  if (!user) return res.status(400).json({ error: 'missing user' });
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'รูปแบบเดือนไม่ถูกต้อง' });
  if (!Number.isFinite(days) || days < 0 || days > 31) {
    return res.status(400).json({ error: 'จำนวนวันต้องอยู่ระหว่าง 0–31' });
  }

  const target = (state.staff || []).find((a) => a.user === user);
  if (!target) return res.status(400).json({ error: 'ไม่พบพนักงานคนนี้' });
  // Same rule as the payroll status: an owner has no wage to count days for.
  if (target.role === 'owner') {
    return res.status(400).json({ error: 'บัญชีเจ้าของร้านไม่มีเงินเดือนให้คำนวณ' });
  }

  const key = `${user}__${month}`;
  // A month already marked จ่ายแล้ว has its wage filed in รายจ่าย at the old
  // figure — changing the days under it would leave the two disagreeing.
  if (state.payroll[key] === 'paid') {
    return res.status(409).json({ error: 'เดือนนี้จ่ายเงินเดือนแล้ว — เปลี่ยนสถานะเป็นยังไม่จ่ายก่อนแก้จำนวนวัน' });
  }
  if (days > 0) state.workdays[key] = days;
  else delete state.workdays[key];

  persist();
  broadcast();
  res.json({ ok: true });
});

// Owner edits ONE staff account: display name, username, password, daily wage.
//
// Deliberately not part of the whole-array PUT /api/staff. Two things that write
// cannot do:
//   * a rename has to carry the person's history with it — days worked and
//     payroll flags are keyed by username, so rewriting the staff array alone
//     would leave a renamed member showing 0 days worked and an unpaid month
//     that was already paid;
//   * the served state strips password hashes, so the array a browser sends back
//     can only keep a password by username match — the moment the username
//     changes, the account reads as brand new and demands a new password.
app.patch('/api/staff/:user', requireOwner, (req, res) => {
  const current = String(req.params.user || '').trim();
  const account = (state.staff || []).find((s) => s.user === current);
  if (!account) return res.status(404).json({ error: 'ไม่พบพนักงานคนนี้' });

  // Every field is optional: what is absent keeps its stored value, so the form
  // can send only what the owner touched.
  const nextUser = String(req.body?.user ?? current).trim();
  const name = String(req.body?.name ?? account.name ?? '').trim();
  const pass = req.body?.pass == null ? '' : String(req.body.pass);
  const pin = req.body?.pin == null ? '' : String(req.body.pin).trim();
  const rawWage = req.body?.dailyWage;
  const role = req.body?.role == null ? (account.role || 'staff') : String(req.body.role);

  if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'สิทธิ์การเข้าถึงไม่ถูกต้อง' });
  if (role !== account.role) {
    // Same lock-out as renaming yourself: dropping your own owner access ends
    // your ability to undo it on the very next request.
    if (req.session.user === current) {
      return res.status(400).json({ error: 'เปลี่ยนสิทธิ์ของบัญชีที่กำลังเข้าใช้งานอยู่ไม่ได้' });
    }
    // And the shop must keep someone who can reach the back office at all.
    const otherOwners = (state.staff || []).filter((s) => s.role === 'owner' && s.user !== current);
    if (account.role === 'owner' && !otherOwners.length) {
      return res.status(400).json({ error: 'ต้องมีบัญชีผู้บริหารอย่างน้อย 1 บัญชี' });
    }
  }

  if (!nextUser) return res.status(400).json({ error: 'ต้องระบุชื่อผู้ใช้' });
  if (nextUser.length > 60) return res.status(400).json({ error: 'ชื่อผู้ใช้ยาวเกินไป' });
  if (name.length > 100) return res.status(400).json({ error: 'ชื่อที่แสดงยาวเกินไป' });
  if (nextUser !== current && (state.staff || []).some((s) => s.user === nextUser)) {
    return res.status(409).json({ error: 'มีชื่อผู้ใช้งานนี้ในระบบแล้ว' });
  }
  // Renaming the account you are signed in as invalidates your own session on
  // the very next request — sessions resolve to a staff record by username — so
  // the owner would be locked out mid-edit with no obvious way back. Everything
  // else about your own account is fine to change.
  if (nextUser !== current && req.session.user === current) {
    return res.status(400).json({
      error: 'เปลี่ยนชื่อผู้ใช้ของบัญชีที่กำลังเข้าใช้งานอยู่ไม่ได้ (จะหลุดออกจากระบบทันที)',
    });
  }

  // A blank PIN box means "keep the current code", the same way the password
  // box does — the form can never tell what is stored, so it must not be able to
  // clear it by accident.
  if (pin) {
    if (!PIN_RE.test(pin)) {
      return res.status(400).json({ error: 'ไอดีพนักงานต้องเป็นตัวเลข 4 หลัก' });
    }
    const clash = pinTakenBy(pin, current);
    if (clash) {
      return res.status(409).json({ error: `ไอดี ${pin} ถูกใช้โดย "${clash.name}" แล้ว — เลือกเลขอื่น` });
    }
  }

  let dailyWage = account.dailyWage || 0;
  if (rawWage !== undefined && rawWage !== null && rawWage !== '') {
    const n = Number(rawWage);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'ค่าแรงต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป' });
    }
    dailyWage = n;
  }

  account.name = name || nextUser;
  // Takes effect at once for everything the server guards (requireOwner and the
  // ผู้จัดการคลัง scope read the live record); the person's screen follows at
  // their next sign-in, since the panel is chosen at login.
  account.role = role;
  // An owner is never on the payroll — see tcMonthlySummary in OwnerView.
  account.dailyWage = role === 'owner' ? 0 : dailyWage;
  if (pass) account.passHash = hashPassword(pass); // blank = keep the old one
  // The code is hashed for checking AND kept as digits for the owner to read
  // back in the ข้อมูลพนักงาน tab — see the note on migrateStaffPasswords.
  if (pin) {
    account.pinHash = hashPassword(pin);
    account.pin = pin;
  }

  if (nextUser !== current) {
    account.user = nextUser;
    const moveKeys = (store) => {
      const moved = {};
      for (const [key, value] of Object.entries(store || {})) {
        const renamed = key.startsWith(`${current}__`)
          ? `${nextUser}__${key.slice(current.length + 2)}`
          : key;
        moved[renamed] = value;
      }
      return moved;
    };
    state.workdays = moveKeys(state.workdays);
    state.payroll = moveKeys(state.payroll);
  }

  persist();
  broadcast();
  console.log(`[backend] Staff account "${current}" updated${nextUser !== current ? ` (renamed to "${nextUser}")` : ''}`);
  res.json({ ok: true, user: account.user, name: account.name, dailyWage: account.dailyWage, role: account.role });
});

// Who is holding the till right now? Takes a 4-digit ไอดีพนักงาน and answers
// with the account it belongs to, so the staff panel can stamp a printed bill
// (or a discount) with a name it did not have to be told.
//
// Signing in is still required — this endpoint identifies a PERSON on an
// already-authenticated device, it does not authenticate the device. A wrong
// PIN is answered 401 with nothing else: no hint about which codes exist.
//
// Guessing is the obvious attack (there are only 10,000 codes), so failures are
// counted per IP and the door shuts long before a run through them; a correct
// PIN clears the count, so ordinary mistyping at a busy till never locks staff
// out for long.
const PIN_WINDOW_MS = 10 * 60 * 1000;
const PIN_MAX_ATTEMPTS = 15;
const pinAttempts = new Map(); // ip -> { count, first }

function pinRateLimited(ip) {
  const now = Date.now();
  const rec = pinAttempts.get(ip);
  if (!rec || now - rec.first > PIN_WINDOW_MS) {
    pinAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > PIN_MAX_ATTEMPTS;
}

app.post('/api/staff/verify-pin', requireAuth, (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (pinRateLimited(ip)) {
    return res.status(429).json({ error: 'ใส่ไอดีผิดหลายครั้งเกินไป กรุณารอสักครู่' });
  }
  // An existing shop upgrading to this feature has no codes yet, and "ไอดีไม่
  // ถูกต้อง" would send staff hunting for a number nobody has been given. Say
  // what is actually wrong, and who can fix it.
  if (!(state.staff || []).some((s) => s.pinHash)) {
    return res.status(409).json({
      error: 'ยังไม่มีการตั้งไอดีพนักงานในระบบ — ให้เจ้าของร้านตั้งที่ "จัดการสิทธิ์พนักงาน" ก่อน',
    });
  }
  const account = findStaffByPin(String(req.body?.pin || '').trim());
  if (!account) {
    return res.status(401).json({ error: 'ไอดีพนักงานไม่ถูกต้อง' });
  }
  pinAttempts.delete(ip); // a correct code means this till is not being probed
  res.json({
    user: account.user,
    name: account.name,
    role: account.role === 'owner' ? 'owner' : 'staff',
    position: account.position || '',
  });
});

// Manually re-pull the menu from the database (e.g. after editing it directly
// in pgAdmin). Staff-only. Broadcasts the refreshed menu to every open tab.
app.post('/api/menu/refresh', requireAuth, async (_req, res) => {
  try {
    const { count, changed } = await syncMenuFromDb();
    if (changed) broadcast();
    console.log(`[backend] Menu refreshed from database (${count} items, ${changed ? 'updated' : 'no change'})`);
    res.json({ ok: true, count, changed });
  } catch (err) {
    console.error('[backend] Menu refresh from database failed:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Push the freshly-changed menu to every open tab right away, instead of
// leaving the owner to wonder for up to 30s whether the edit landed.
async function refreshMenuAndBroadcast() {
  const { count } = await syncMenuFromDb();
  broadcast();
  return count;
}

// The values the owner's dropdowns offer, taken from what is already in the
// table so a new category never has to be added in code.
app.get('/api/menu/options', requireAuth, async (_req, res) => {
  try {
    res.json(await fetchMenuOptions());
  } catch (err) {
    console.error('[backend] Could not read menu options:', err.message);
    res.status(502).json({ error: 'อ่านตัวเลือกจากฐานข้อมูลไม่สำเร็จ' });
  }
});

// Store one menu photo and hand back the path to save in image_url. The reply
// is deliberately the public path only — never the location on disk.
app.post('/api/menu/upload', requireAuth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig ? 'ไฟล์ใหญ่เกิน 5MB' : (err.message || 'อัปโหลดรูปไม่สำเร็จ'),
      });
    }
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
    res.json({ url: `/uploads/${req.file.filename}` });
  });
});

// Validate the new-dish payload. Returns { value } or { error }.
function parseMenuItemBody(body) {
  const str = (v) => String(v ?? '').trim();
  const category = str(body?.category);
  const type = str(body?.type) || 'เมนูหลัก';
  const subcategory = str(body?.subcategory);
  const name = str(body?.name);
  // Optional English companions. Blank is a valid answer — the ENG menu falls
  // back to the Thai text — but they must round-trip, because updateMenuItem
  // rewrites the dish's rows from exactly this spec.
  const nameEn = str(body?.nameEn);
  const subcategoryEn = str(body?.subcategoryEn);
  const rawTheme = str(body?.theme);
  const theme = ['day', 'night', 'both', 'none'].includes(rawTheme) ? rawTheme : 'day';
  const imageUrl = str(body?.imageUrl);

  if (!name) return { error: 'กรุณากรอกชื่อรายการ' };
  if (!category) return { error: 'กรุณาเลือกหมวดหมู่' };
  if (name.length > 200) return { error: 'ชื่อรายการยาวเกินไป' };
  if (nameEn.length > 200) return { error: 'ชื่อรายการ (EN) ยาวเกินไป' };
  if (subcategoryEn.length > 200) return { error: 'หัวข้อ (EN) ยาวเกินไป' };

  // Only a path we issued, or an external link of the kind the imported data
  // already holds. Anything else (javascript:, data:) is refused rather than
  // stored and later rendered into an <img src>.
  //
  // Two shapes are accepted: the UUID name multer generates (/uploads/<uuid>.jpg),
  // and the bulk-imported menu photos that live in /uploads/Foods|Drinks/ under
  // their original, human-readable names (spaces, parentheses, etc). The filename
  // segment forbids "/" and "\", so neither shape can traverse out of /uploads.
  if (imageUrl
      && !/^\/uploads\/(?:Foods\/|Drinks\/)?[^/\\]+\.(?:jpg|png|webp)$/i.test(imageUrl)
      && !/^https?:\/\//i.test(imageUrl)) {
    return { error: 'ลิงก์รูปภาพไม่ถูกต้อง' };
  }

  // No protein choices -> a single row whose เนื้อสัตว์ is "-", matching how the
  // imported data spells "not applicable".
  const rawVariants = Array.isArray(body?.variants) && body.variants.length
    ? body.variants
    : [{ meat: '-', price: body?.price }];

  const variants = [];
  for (const v of rawVariants) {
    const meat = str(v?.meat) || '-';
    const meatEn = str(v?.meatEn);
    const price = Number(v?.price);
    if (!Number.isFinite(price) || price < 0) {
      return { error: `ราคาของ "${meat === '-' ? name : meat}" ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป` };
    }
    if (meatEn.length > 200) return { error: `ตัวเลือก "${meat}" (EN) ยาวเกินไป` };
    variants.push({ meat, meatEn, price: Math.round(price) });
  }
  if (variants.length > 20) return { error: 'ตัวเลือกเนื้อสัตว์มากเกินไป' };

  const meats = variants.map((v) => v.meat);
  if (new Set(meats).size !== meats.length) {
    return { error: 'มีตัวเลือกเนื้อสัตว์ซ้ำกัน' };
  }

  return {
    value: { category, type, subcategory, subcategoryEn, name, nameEn, theme, imageUrl, variants },
  };
}

// Add a dish. One row goes in per protein option, all sharing the image, which
// is what makes the transforms fold them back into a single card with options.
//
// An optional `stockQuantity` (เพิ่มเมนูในสต็อก) files the dish in คลังวัตถุดิบ in
// the same call. It is done here rather than as a second request from the
// browser so that an inventory manager — who may only add a dish that lives in
// the คลัง — cannot add one and simply skip the stock half.
app.post('/api/menu/items', requireAuth, async (req, res) => {
  const { value, error } = parseMenuItemBody(req.body);
  if (error) return res.status(400).json({ error });

  const hasStock = req.body?.stockQuantity != null;
  const stockQuantity = Number(req.body?.stockQuantity);
  if (hasStock && (!Number.isInteger(stockQuantity) || stockQuantity < 0)) {
    return res.status(400).json({ error: 'จำนวนในคลังต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป' });
  }

  try {
    if (!hasStock && isInventoryManager(req) && !(await stockedNames()).has(stockKey(value.name))) {
      return res.status(403).json({ error: OUT_OF_SCOPE });
    }
    if (await dishIdentityTaken(value)) {
      return res.status(409).json({ error: 'มีเมนูชื่อนี้อยู่แล้วในหัวข้อและกะเดียวกัน' });
    }
    const inserted = await insertMenuItem(value);

    // Best-effort, like the browser-side call it replaces: the dish is saved
    // either way, and the reply says whether the คลัง half took.
    let stockItem = null;
    let stockError = null;
    if (hasStock) {
      try {
        stockItem = await createStockItem({
          category: value.category,
          name: value.name,
          quantity: stockQuantity,
          imageUrl: value.imageUrl,
        });
        logStock(req, {
          action: 'create', itemId: stockItem.id, itemName: stockItem.name,
          category: stockItem.category, delta: stockQuantity, quantityAfter: stockItem.quantity,
        });
      } catch (stockErr) {
        console.error('[backend] Added the dish but not its คลัง row:', stockErr.message);
        stockError = 'เพิ่มรายการในคลังไม่สำเร็จ';
      }
    }

    const count = await refreshMenuAndBroadcast();
    console.log(`[backend] Added menu item "${value.name}" (${inserted} row(s)); menu now ${count} items`);
    res.json({ ok: true, rows: inserted, stockItem, stockError });
  } catch (err) {
    console.error('[backend] Could not add menu item:', err.message);
    res.status(502).json({ error: err.message || 'บันทึกเมนูไม่สำเร็จ' });
  }
});

// Read one dish back in its editable form (category/type/subcategory + variants),
// so the owner's edit screen can pre-fill the same form the create screen uses.
app.get('/api/menu/items/:id', requireAuth, requireStockedDish, async (req, res) => {
  try {
    const dish = await getDishForEdit(String(req.params.id));
    if (!dish) return res.status(404).json({ error: 'ไม่พบเมนูนี้ในฐานข้อมูล' });
    res.json(dish);
  } catch (err) {
    console.error('[backend] Could not load menu item:', err.message);
    res.status(502).json({ error: err.message || 'โหลดเมนูไม่สำเร็จ' });
  }
});

// Edit an existing dish. Reuses the same validation as adding one, then replaces
// the dish's rows (see updateMenuItem) and broadcasts the refreshed menu.
app.put('/api/menu/items/:id', requireAuth, requireStockedDish, async (req, res) => {
  const { value, error } = parseMenuItemBody(req.body);
  if (error) return res.status(400).json({ error });
  const id = String(req.params.id);

  try {
    // Renaming is a way out of scope too: the new name has to be one the คลัง
    // knows, or the dish would stop being linked the moment it saved.
    if (isInventoryManager(req) && !(await stockedNames()).has(stockKey(value.name))) {
      return res.status(403).json({ error: OUT_OF_SCOPE });
    }
    // Ignore the dish's own rows so renaming nothing isn't read as a collision.
    if (await dishIdentityTaken(value, id)) {
      return res.status(409).json({ error: 'มีเมนูชื่อนี้อยู่แล้วในหัวข้อและกะเดียวกัน' });
    }
    const updated = await updateMenuItem(id, value);
    if (!updated) return res.status(404).json({ error: 'ไม่พบเมนูนี้ในฐานข้อมูล' });

    // A dish and its คลัง row are the same product, so the photo follows the
    // menu. Done HERE rather than in the browser because the match is by name
    // and the database's rule (LOWER(TRIM)) is the looser, correct one — see
    // setStockImageByName. Best-effort: a stock table that is unreachable must
    // not turn a saved menu edit into a reported failure.
    let stockImage = null;
    try {
      stockImage = await setStockImageByName(value.name, value.imageUrl || '');
    } catch (stockErr) {
      console.warn(`[backend] Could not mirror the photo onto the คลัง row: ${stockErr.message}`);
    }

    const count = await refreshMenuAndBroadcast();
    console.log(`[backend] Updated menu item "${value.name}" (${updated} row(s)); menu now ${count} items`);
    res.json({ ok: true, rows: updated, stockImageUpdated: !!stockImage });
  } catch (err) {
    console.error('[backend] Could not update menu item:', err.message);
    res.status(502).json({ error: err.message || 'แก้ไขเมนูไม่สำเร็จ' });
  }
});

// Remove a dish from the menu for good. This is the one destructive menu write,
// so the owner's screen asks for a confirmation first; hiding a dish (the
// sun/moon pill sending theme 'none') is the reversible alternative.
app.delete('/api/menu/items/:id', requireAuth, requireStockedDish, async (req, res) => {
  const id = String(req.params.id);
  // Read the name off the live menu BEFORE the rows go, so the leftovers this
  // dish has elsewhere can be found afterwards.
  const doomed = (state.menu || []).find((m) => m.id === id);

  try {
    const removed = await deleteMenuItem(id);
    if (!removed) return res.status(404).json({ error: 'ไม่พบเมนูนี้ในฐานข้อมูล' });

    // The rows are gone for good now, so take the dish out of the served menu
    // here rather than leaving that to the re-read below. fetchMenuFromDb
    // deliberately REFUSES to answer a table that yields no dishes — a guard so
    // a broken import cannot wipe the menu — which means deleting the very last
    // dish would throw on the re-read and leave the deleted dish on screen,
    // reported as a failure it wasn't.
    state.menu = (state.menu || []).filter((m) => m.id !== id);

    // A deleted dish must be gone EVERYWHERE, not just off the menu. Two things
    // used to survive it and keep showing the dish's name after it was gone:
    //
    //   * its คลังวัตถุดิบ row — left behind on the theory that the stockroom
    //     count is its own record. In practice that is a deleted dish still
    //     sitting in the คลัง list with a photo, which is exactly what it looks
    //     like: a delete that did not take.
    //   * its ตัวเลือกเสริม links — a dead dish id inside preset.menuIds.
    //
    // The คลัง row only goes if NOTHING else on the menu still answers to that
    // name. The day and night menus genuinely share dish names (ข้าวผัด is on
    // both), so deleting the day one must not empty the shelf the night one
    // still sells from.
    let stockRemoved = null;
    const name = doomed?.name;
    if (name) {
      const stillSold = state.menu.some(
        (m) => m.name.trim().toLowerCase() === name.trim().toLowerCase()
      );
      if (!stillSold) {
        try {
          stockRemoved = await deleteStockItemByName(name);
          if (stockRemoved) {
            // Stock leaving the building is always accountable, deletions
            // included — the count drops to 0 in the history, not into thin air.
            logStock(req, {
              action: 'adjust',
              itemId: stockRemoved.id,
              itemName: stockRemoved.name,
              category: stockRemoved.category,
              delta: -stockRemoved.quantity,
              quantityAfter: 0,
              note: 'ลบเมนูนี้ออกจากระบบ',
            });
          }
        } catch (stockErr) {
          console.warn(`[backend] Deleted the dish but not its คลัง row: ${stockErr.message}`);
        }
      }
    }

    // Prune the dead id out of every preset that pointed at it — both the
    // ตัวเลือกเสริม sets and the owner's กลุ่มเมนู for the stats table.
    for (const key of ['addonPresets', 'menuPresets']) {
      if (!Array.isArray(state[key])) continue;
      state[key] = state[key].map((p) =>
        (p.menuIds || []).includes(id)
          ? { ...p, menuIds: p.menuIds.filter((mid) => mid !== id) }
          : p
      );
    }
    persist();

    let count = state.menu.length;
    try {
      count = await refreshMenuAndBroadcast();
    } catch (syncErr) {
      // The delete still stands; only the re-read failed. Push what we have.
      console.warn(`[backend] Deleted the dish but could not re-read the menu: ${syncErr.message}`);
      broadcast();
    }
    console.log(
      `[backend] Deleted menu item ${id} (${removed} row(s)); menu now ${count} items` +
      (stockRemoved ? ` · also removed its คลัง row (was ${stockRemoved.quantity})` : '')
    );
    res.json({ ok: true, rows: removed, stockRemoved: stockRemoved?.name || null });
  } catch (err) {
    console.error('[backend] Could not delete menu item:', err.message);
    res.status(502).json({ error: err.message || 'ลบเมนูไม่สำเร็จ' });
  }
});

// Put a dish on or off sale. Keyed by the dish id the app already renders —
// see setDishAvailability() for why matching on name would be unreliable.
app.patch('/api/menu/items/availability', requireAuth, requireStockedDish, async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const available = req.body?.available;
  if (!id) return res.status(400).json({ error: 'ต้องระบุรหัสเมนู' });
  if (typeof available !== 'boolean') {
    return res.status(400).json({ error: 'ค่า available ต้องเป็น true หรือ false' });
  }

  try {
    const updated = await setDishAvailability(id, available);
    if (!updated) return res.status(404).json({ error: 'ไม่พบเมนูนี้ในฐานข้อมูล' });
    await refreshMenuAndBroadcast();
    res.json({ ok: true, rows: updated });
  } catch (err) {
    console.error('[backend] Could not change availability:', err.message);
    res.status(502).json({ error: err.message || 'เปลี่ยนสถานะไม่สำเร็จ' });
  }
});

// Set which shift(s) a dish shows in — day / night / both / none. Drives the
// sun/moon pill in จัดการเมนู: 'none' hides the dish from every storefront
// without deleting it. See setDishTheme() for why it also clears ปิดขาย.
app.patch('/api/menu/items/theme', requireAuth, requireStockedDish, async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const theme = String(req.body?.theme || '').trim();
  if (!id) return res.status(400).json({ error: 'ต้องระบุรหัสเมนู' });
  if (!['day', 'night', 'both', 'none'].includes(theme)) {
    return res.status(400).json({ error: "ค่า theme ต้องเป็น day, night, both หรือ none" });
  }

  try {
    const updated = await setDishTheme(id, theme);
    if (!updated) return res.status(404).json({ error: 'ไม่พบเมนูนี้ในฐานข้อมูล' });
    await refreshMenuAndBroadcast();
    res.json({ ok: true, rows: updated });
  } catch (err) {
    console.error('[backend] Could not change theme:', err.message);
    res.status(502).json({ error: err.message || 'เปลี่ยนกะที่แสดงไม่สำเร็จ' });
  }
});

// Rearrange the menu. The body is the dish ids in their new order, exactly as
// the owner dragged them in จัดการเมนู; the customer menu renders the array in
// the order it arrives, so this is what the diner ends up seeing.
app.patch('/api/menu/order', requireAuth, async (req, res) => {
  const raw = req.body?.ids;
  if (!Array.isArray(raw) || !raw.length) {
    return res.status(400).json({ error: 'ต้องระบุลำดับเมนู' });
  }
  // A menu of a few hundred dishes is normal; ten thousand ids is not a drag,
  // it is a malformed (or hostile) body, and the UNNEST behind it is unbounded.
  if (raw.length > 5000) return res.status(400).json({ error: 'รายการเมนูมากเกินไป' });
  const ids = raw.map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ต้องระบุลำดับเมนู' });

  try {
    // An inventory manager reorders only the stocked dishes among themselves:
    // every slot held by a dish outside their scope must come back untouched.
    // That is exactly what their screen sends (see commitMove in OwnerMenu), so
    // a mismatch is a stale tab or a hand-made request.
    if (isInventoryManager(req)) {
      const stocked = await stockedNames();
      const current = state.menu || [];
      const sent = new Set(ids);
      const intact = ids.length === current.length
        && current.every((m) => sent.has(m.id)) // a permutation, no strays or repeats
        && current.every((m, i) => stocked.has(stockKey(m.name)) || ids[i] === m.id);
      if (!intact) {
        return res.status(403).json({ error: `${OUT_OF_SCOPE} (หรือเมนูเพิ่งถูกแก้จากเครื่องอื่น — ลองใหม่อีกครั้ง)` });
      }
    }
    const updated = await setDishOrder(ids);
    if (!updated) return res.status(404).json({ error: 'ไม่พบเมนูที่จะเรียงลำดับ' });
    await refreshMenuAndBroadcast();
    console.log(`[backend] Menu reordered (${updated} row(s))`);
    res.json({ ok: true, rows: updated });
  } catch (err) {
    console.error('[backend] Could not reorder menu:', err.message);
    res.status(502).json({ error: err.message || 'เรียงลำดับเมนูไม่สำเร็จ' });
  }
});

// --- Stock (คลังวัตถุดิบ) ----------------------------------------------------
// The staff inventory tab reads and edits the `stock_items` table directly.
// Separate from the in-memory drink `stock` used when taking an order.

// Append one line to the stock history (ประวัติการบันทึกสต็อก), stamping the
// logged-in user (and their display name). Best-effort: a logging failure must
// never break the stock change itself, so it's fire-and-forget with a warning.
function logStock(req, fields) {
  const user = req.session?.user || null;
  const acct = (state.staff || []).find((s) => s.user === user);
  logStockChange({ ...fields, byUser: user, byName: acct?.name || user }).catch((err) =>
    console.warn(`[backend] stock history log failed: ${err.message}`)
  );
}

// The count never drops below 0, so a cut bigger than what is on hand moves by
// less than was asked. The history must record the real movement — otherwise
// adding it up no longer gives the on-hand count — and say that the shelf ran
// short, which is itself a sign the count had drifted.
function shortfallNote(requested, moved, before) {
  if (moved === requested) return null;
  return `ขอตัด ${Math.abs(requested)} แต่คลังเหลือ ${before} — ตัดได้ ${Math.abs(moved)}`;
}

// A stock row as the client sees it (the internal before-count stays here).
const stockRowOut = ({ quantityBefore: _before, ...row }) => row;

// The whole inventory.
app.get('/api/stock-items', requireAuth, async (_req, res) => {
  try {
    res.json({ items: await fetchStockItems() });
  } catch (err) {
    console.error('[backend] Could not read stock_items:', err.message);
    res.status(502).json({ error: 'อ่านคลังวัตถุดิบจากฐานข้อมูลไม่สำเร็จ' });
  }
});

// Create a stock item (or top up an existing one with the same name). Backs the
// owner's "อัพเดทสตอก" action, which adds a dish and its inventory row at once.
app.post('/api/stock-items', requireAuth, async (req, res) => {
  const category = String(req.body?.category || '').trim() || 'ทั่วไป';
  const name = String(req.body?.name || '').trim();
  const quantity = Number(req.body?.quantity);
  const imageUrl = String(req.body?.imageUrl || '').trim();
  if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อรายการ' });
  if (!Number.isInteger(quantity) || quantity < 0) {
    return res.status(400).json({ error: 'จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป' });
  }
  try {
    const item = await createStockItem({ category, name, quantity, imageUrl });
    logStock(req, {
      action: 'create', itemId: item.id, itemName: item.name,
      category: item.category, delta: quantity, quantityAfter: item.quantity,
    });
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[backend] Could not create stock item:', err.message);
    res.status(502).json({ error: 'เพิ่มรายการในคลังไม่สำเร็จ' });
  }
});

// Public, read-only stock levels for the customer storefront (no auth). Returns
// [{ name, quantity }] so CustomerView can grey out a dish whose linked stock
// has hit 0. If the DB is unreachable we return an empty list rather than an
// error, so the menu still shows (fails open — never hides food on a DB hiccup).
app.get('/api/stock-availability', async (_req, res) => {
  try {
    res.json({ items: await fetchStockAvailability() });
  } catch (err) {
    console.error('[backend] Could not read stock availability:', err.message);
    res.json({ items: [] });
  }
});

// Adjust one item's quantity by { delta } (e.g. +1 / +10 / -1). Never below 0.
// An optional { reason } explains a removal (e.g. "เจ้าของดื่มเอง") and is kept
// in the stock history so a shrinking count is always accountable.
// Edit one stock row. Two independent edits ride this endpoint:
//   * `delta`    — bump the count (+1 / -1 ...), logged to the stock history.
//   * `imageUrl` — replace the photo, mirrored here when the owner changes a
//                  dish's picture from the menu screen so the คลัง row keeps the
//                  same image. No history line — the count didn't move.
// Either may be sent alone or together; at least one is required.
app.patch('/api/stock-items/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'รหัสสินค้าไม่ถูกต้อง' });

  const hasDelta = req.body?.delta !== undefined && req.body?.delta !== null;
  const hasImage = typeof req.body?.imageUrl === 'string';
  const delta = Number(req.body?.delta);
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || null;
  const imageUrl = hasImage ? req.body.imageUrl.trim() : '';

  if (hasDelta && !Number.isFinite(delta)) {
    return res.status(400).json({ error: 'ค่า delta ต้องเป็นตัวเลข' });
  }
  if (!hasDelta && !hasImage) {
    return res.status(400).json({ error: 'ไม่มีข้อมูลที่จะแก้ไข' });
  }
  // Same guard the menu endpoint uses: only the shapes an <img src> can display
  // are stored, and the filename segment can't traverse out of /uploads.
  if (imageUrl
      && !/^\/uploads\/(?:Foods\/|Drinks\/)?[^/\\]+\.(?:jpg|png|webp)$/i.test(imageUrl)
      && !/^https?:\/\//i.test(imageUrl)) {
    return res.status(400).json({ error: 'ลิงก์รูปภาพไม่ถูกต้อง' });
  }

  try {
    let item = null;
    if (hasImage) {
      item = await setStockItemImage(id, imageUrl);
      if (!item) return res.status(404).json({ error: 'ไม่พบสินค้านี้ในคลัง' });
    }
    if (hasDelta) {
      const row = await adjustStockItem(id, delta);
      if (!row) return res.status(404).json({ error: 'ไม่พบสินค้านี้ในคลัง' });
      const moved = row.quantity - row.quantityBefore;
      const shortfall = shortfallNote(delta, moved, row.quantityBefore);
      item = stockRowOut(row);
      logStock(req, {
        action: 'adjust', itemId: item.id, itemName: item.name,
        category: item.category, delta: moved, quantityAfter: item.quantity,
        note: [reason, shortfall].filter(Boolean).join(' · ') || null,
      });
    }
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[backend] Could not update stock item:', err.message);
    res.status(502).json({ error: 'แก้ไขคลังไม่สำเร็จ' });
  }
});

// Remove one row from คลังวัตถุดิบ for good. The owner's way out of a row that
// no longer belongs there — most often one orphaned by an older delete, back
// when removing a dish left its stock row behind, or by a dish being renamed
// (the dish↔stock link is by name, so a rename strands the old row and the new
// name stops deducting).
//
// Logged like any other stock movement: the count goes to 0 in the history with
// a reason, never silently.
app.delete('/api/stock-items/:id', requireAuth, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'รหัสสินค้าไม่ถูกต้อง' });
  try {
    const item = await deleteStockItem(id);
    if (!item) return res.status(404).json({ error: 'ไม่พบสินค้านี้ในคลัง' });
    logStock(req, {
      action: 'adjust', itemId: item.id, itemName: item.name,
      category: item.category, delta: -item.quantity, quantityAfter: 0,
      note: 'ลบรายการออกจากคลัง',
    });
    res.json({ ok: true, item });
  } catch (err) {
    console.error('[backend] Could not delete stock item:', err.message);
    res.status(502).json({ error: 'ลบรายการในคลังไม่สำเร็จ' });
  }
});

// Deduct { name, qty } from the stock row matched by dish name — fired when
// staff mark a dish เสิร์ฟแล้ว (negative qty restores it on un-serve). A dish
// with no matching row returns { item: null } rather than 404: not every menu
// item is stock-linked, and the serve tap must not fail because of that.
//
// An optional { opKey } makes the call safe to repeat: the tablet retries a cut
// whose reply it never got, and a key already applied is not cut again.
app.post('/api/stock-items/consume', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const qty = Number(req.body?.qty);
  const opKey = String(req.body?.opKey || '').trim().slice(0, 100) || null;
  if (!name) return res.status(400).json({ error: 'ต้องระบุชื่อรายการ' });
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 999) {
    return res.status(400).json({ error: 'ค่า qty ต้องเป็นจำนวนเต็มไม่เกิน ±999' });
  }
  try {
    const { item: row, duplicate } = await consumeStockByName(name, qty, opKey);
    const item = row ? stockRowOut(row) : null;
    // Only log a real movement — an unmatched name is a no-op (item === null),
    // and a repeated opKey was already logged the first time.
    if (row && !duplicate) {
      const moved = row.quantity - row.quantityBefore;
      logStock(req, {
        action: qty >= 0 ? 'serve' : 'unserve', itemId: item.id, itemName: item.name,
        category: item.category, delta: moved, quantityAfter: item.quantity,
        note: shortfallNote(-qty, moved, row.quantityBefore),
      });
    }
    res.json({ ok: true, item, duplicate });
  } catch (err) {
    console.error('[backend] Could not consume stock:', err.message);
    res.status(502).json({ error: 'ตัดสต็อกไม่สำเร็จ' });
  }
});

// Bump every item by { delta } (the "เติมทั้งหมด" buttons).
app.post('/api/stock-items/restock', requireAuth, async (req, res) => {
  const delta = Number(req.body?.delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'ค่า delta ต้องเป็นตัวเลข' });
  try {
    const { changed, clamped } = await restockAll(delta);
    // One aggregate line for the whole เติมทั้งหมด, since there's no single count.
    logStock(req, {
      action: 'restock-all', itemName: `ทั้งหมด (${changed} รายการ)`,
      delta, quantityAfter: null,
      note: clamped ? `${clamped} รายการเหลือไม่ถึง ${Math.abs(delta)} — ตัดได้ไม่เต็ม` : null,
    });
    res.json({ ok: true, changed });
  } catch (err) {
    console.error('[backend] Could not restock all:', err.message);
    res.status(502).json({ error: 'เติมสต็อกทั้งหมดไม่สำเร็จ' });
  }
});

// The audit trail behind the "ประวัติ" panel: who changed the stock, when, and
// by how much. Newest first; capped so a long history never floods the client.
app.get('/api/stock-history', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query?.limit, 10) || 200, 1), 500);
  // Optional working day to show ('YYYY-MM-DD'); absent = latest across all days.
  const date = req.query?.date ? String(req.query.date) : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
  }
  try {
    res.json({ items: await fetchStockHistory(limit, date) });
  } catch (err) {
    console.error('[backend] Could not read stock history:', err.message);
    res.status(502).json({ error: 'อ่านประวัติการบันทึกสต็อกไม่สำเร็จ' });
  }
});

// --- Serve the built frontend (production) ---------------------------------
// In production this same server also serves the compiled React app, so the
// whole thing is ONE origin: the frontend's relative /api and /uploads calls
// (and the SSE stream) just work, with no CORS list or reverse proxy to set up.
// In local dev this folder doesn't exist and Vite serves the app itself with
// its own proxy (see frontend/vite.config.js), so this block is skipped.
const CLIENT_DIR = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, { index: false, maxAge: '1h' }));
  // SPA fallback: any non-API, non-upload GET returns index.html, so a deep
  // link or a page refresh on a client-side route still loads the app.
  app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
  });
  console.log('[backend] Serving built frontend from frontend/dist');
}

// Central error handler: turn a rejected CORS origin or malformed JSON body
// into a clean status code, and never leak a stack trace to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (/Origin not allowed/.test(err.message || '')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error('[backend] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`[backend] API + real-time server running on http://localhost:${PORT}`);

  // Bring orders in from PostgreSQL. On the very first run the table is empty,
  // so whatever is already in data.json is migrated up into it — nobody has to
  // move their existing sales by hand.
  if (HAS_DB) {
    (async () => {
      await ensureOrdersTable();
      // The stock audit trail lives in its own table — create it on first run so
      // logging never fails on a fresh clone.
      await ensureStockHistoryTable().catch((err) =>
        console.warn(`[backend] Could not ensure stock_history table: ${err.message}`)
      );
      const dbOrders = await loadOrders();
      if (dbOrders.length) {
        // The database is the source of truth.
        state.orders = dropAbsorbed(dbOrders).map(withRoundKeys);
        persist();
        broadcast();
        console.log(`[backend] Loaded ${dbOrders.length} order(s) from PostgreSQL`);
      } else if (Array.isArray(state.orders) && state.orders.length) {
        const moved = await saveOrders(state.orders);
        console.log(`[backend] Migrated ${moved} existing order(s) from data.json into PostgreSQL`);
      } else {
        console.log('[backend] Orders table ready (no orders yet)');
      }
    })().catch((err) =>
      console.warn(`[backend] Orders are NOT being saved to PostgreSQL — check DATABASE_URL. (${err.message})`)
    );
  }

  // Sync the menu from PostgreSQL on startup. If the DB is unreachable the app
  // keeps running on the last-known (seed/persisted) menu.
  if (HAS_DB) {
    // Add the sort_order column first, so the very first sync already reads the
    // menu in the owner's order rather than needing a second pass.
    ensureMenuOrderColumn()
      .then(syncMenuFromDb)
      .then(({ count }) => {
        broadcast();
        console.log(`[backend] Menu synced from PostgreSQL (${count} items)`);
      })
      .catch((err) =>
        console.warn(`[backend] Could not sync menu from PostgreSQL — using stored menu. (${err.message})`)
      )
      // Poll regardless of how the first sync went: the DB may recover.
      .finally(startMenuPolling);
  }
});

// If the port is still held by a leftover process, explain how to fix it
// instead of dumping a raw stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[backend] Port ${PORT} is already in use — an old server is probably still running.\n` +
      `          Close it, or on Windows run:  taskkill /F /IM node.exe\n` +
      `          Then run "npm run dev" again.\n`
    );
    process.exit(1);
  }
  throw err;
});
