// ---------------------------------------------------------------------------
// Stock cuts that did not reach the server (ตัดสต็อกค้าง)
// ---------------------------------------------------------------------------
// A serve tap cuts the คลังวัตถุดิบ row over the network. If that request fails
// — Wi-Fi dropped, server restarting — the dish is still on the table and marked
// เสิร์ฟแล้ว, so the cut must not simply be forgotten: that is how the on-hand
// count ends up higher than the shelf. Failed cuts wait here and are sent again.
//
// Each cut carries an `opKey` made once, when it was first tried. The server
// records applied keys, so a cut that did land (only its reply was lost) is not
// applied a second time when retried.
//
// The queue is kept in localStorage so a reload or a tablet that goes to sleep
// does not lose it. It holds dish names and counts only — nothing about a login.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'pendingStockCuts';

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((op) => op && op.name && op.qty && op.opKey) : [];
  } catch {
    return [];
  }
}

let queue = load();
let flushing = false;

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Private mode / full storage: the queue still lives for this page.
  }
}

// One key per cut. crypto.randomUUID only exists on https/localhost, and the
// shop tablets reach the server over plain http on the LAN, so fall back.
export function newStockOpKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function pendingStockCutCount() {
  return queue.length;
}

export function queueStockCut(op) {
  if (queue.some((q) => q.opKey === op.opKey)) return;
  queue = [...queue, { name: op.name, qty: op.qty, opKey: op.opKey }];
  save();
}

// A 4xx other than an expired login means the server understood the cut and
// refused it — sending it again gives the same answer.
export const isPermanentStockError = (err) =>
  !!err?.status && err.status >= 400 && err.status < 500 && ![401, 408, 429].includes(err.status);

// Send every waiting cut through `send(name, qty, opKey)`, oldest first. Stops at
// the first failure worth retrying (the connection is likely still down); drops a
// cut the server refused outright. Resolves to { rows, sent, dropped }.
export async function flushStockCuts(send) {
  const result = { rows: [], sent: 0, dropped: [] };
  if (flushing || queue.length === 0) return result;
  flushing = true;
  try {
    for (const op of [...queue]) {
      try {
        result.rows.push(await send(op.name, op.qty, op.opKey));
        result.sent += 1;
      } catch (err) {
        if (!isPermanentStockError(err)) break;
        result.dropped.push({ ...op, error: err.message });
      }
      queue = queue.filter((q) => q.opKey !== op.opKey);
      save();
    }
  } finally {
    flushing = false;
  }
  return result;
}
