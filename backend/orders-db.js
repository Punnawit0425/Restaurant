// ---------------------------------------------------------------------------
// PostgreSQL <-> orders bridge
// ---------------------------------------------------------------------------
// Sales data is the one thing in this app that must not be lost, so orders are
// persisted to Postgres rather than living only in backend/data.json.
//
// Two design choices worth knowing:
//
//   1. UPSERT, NEVER DELETE. The client PUTs the whole orders array, so a tab
//      running on a slightly stale copy could otherwise wipe an order another
//      tab just added. Writing row-by-row keyed on `id` means concurrent tabs
//      MERGE instead of clobbering each other. The app never deletes an order
//      (cancelling sets status='cancelled'), so nothing here needs to.
//
//   2. EVERY ORDER IS STORED TWICE, on purpose. The full object goes in the
//      `data` JSONB column, so a field the app adds later (invoice number,
//      paidAt, ...) is preserved without a migration. The fields worth
//      querying are ALSO broken out into real columns, so reports can be
//      written in plain SQL from pgAdmin.
//
// Only orders that actually changed are written, so the usual "staff taps one
// button" PUT costs a single-row upsert rather than rewriting the day's sales.
// ---------------------------------------------------------------------------

import { getPool } from './db.js';

// Remembers what we last wrote per order id, so an unchanged order is skipped.
// Populated by loadOrders() on boot and kept in step by saveOrders().
let lastSaved = new Map();

// Create the table on first run so a fresh clone works without anyone having
// to paste SQL into pgAdmin. orders_schema.sql documents the same shape.
export async function ensureOrdersTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS orders (
      id         TEXT PRIMARY KEY,
      no         TEXT,
      invoice_no TEXT,
      table_no   TEXT,
      status     TEXT NOT NULL DEFAULT 'new',
      shift      TEXT,
      total      NUMERIC(12,2) NOT NULL DEFAULT 0,
      order_time TEXT,
      created_at BIGINT,
      note       TEXT,
      by_user    TEXT,
      items      JSONB NOT NULL DEFAULT '[]'::jsonb,
      data       JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Speeds up the report queries that scan by day / by status.
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at)`
  );
  await getPool().query(
    `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`
  );
}

// Read every order back as the plain object the app expects. The `data` column
// holds the original shape, so nothing is lost in the round trip.
export async function loadOrders() {
  const { rows } = await getPool().query(
    `SELECT data FROM orders ORDER BY created_at NULLS FIRST, id`
  );
  const orders = rows.map((r) => r.data).filter((o) => o && typeof o === 'object');
  // Re-arm the change tracker so the first save after boot only writes deltas.
  lastSaved = new Map(orders.map((o) => [String(o.id), JSON.stringify(o)]));
  return orders;
}

// The 12 values one order contributes to the INSERT, in column order.
function toRow(order) {
  return [
    String(order.id),
    order.no ?? null,
    order.invoiceNo ?? null,
    order.table != null ? String(order.table) : null,
    order.status || 'new',
    order.type ?? null,
    Number(order.total) || 0,
    order.time ?? null,
    Number(order.createdAt) || null,
    order.note ?? null,
    order.by ?? null,
    JSON.stringify(order.items ?? []),
    JSON.stringify(order),
  ];
}

const COLUMNS = [
  'id', 'no', 'invoice_no', 'table_no', 'status', 'shift', 'total',
  'order_time', 'created_at', 'note', 'by_user', 'items', 'data',
];

// Persist the orders that differ from what we last wrote. Returns how many rows
// were touched, so the caller can log something meaningful.
export async function saveOrders(orders) {
  if (!Array.isArray(orders)) return 0;

  const changed = [];
  for (const order of orders) {
    if (!order || order.id == null) continue; // ignore malformed entries
    const id = String(order.id);
    const snapshot = JSON.stringify(order);
    if (lastSaved.get(id) !== snapshot) changed.push(order);
  }
  if (!changed.length) return 0;

  // Collapse duplicate ids to one row (keeping the latest) before building the
  // batch. Two orders can momentarily share the same generated id; a multi-row
  // upsert that lists the same conflict key twice is rejected WHOLESALE by
  // Postgres ("ON CONFLICT DO UPDATE command cannot affect row a second time"),
  // which would block every order in the batch — not just the collision — and
  // silently stall the mirror until a human notices. Deduping keeps one bad id
  // from taking the rest of the day's sales down with it.
  const byId = new Map();
  for (const order of changed) byId.set(String(order.id), order);
  const rows = [...byId.values()];

  // Build one multi-row INSERT ... ON CONFLICT so a burst of changes is a
  // single round trip: ($1,...,$13), ($14,...,$26), ...
  const values = [];
  const tuples = rows.map((order, i) => {
    const row = toRow(order);
    values.push(...row);
    const base = i * COLUMNS.length;
    return `(${row.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const updates = COLUMNS
    .filter((c) => c !== 'id')
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');

  await getPool().query(
    `INSERT INTO orders (${COLUMNS.join(', ')})
     VALUES ${tuples.join(', ')}
     ON CONFLICT (id) DO UPDATE SET ${updates}, updated_at = now()`,
    values
  );

  // Only record success: a failed write must be retried on the next save.
  for (const order of rows) {
    lastSaved.set(String(order.id), JSON.stringify(order));
  }
  return rows.length;
}
