// ---------------------------------------------------------------------------
// Shared PostgreSQL connection pool
// ---------------------------------------------------------------------------
// One pool for the whole process, created lazily so importing a module that
// talks to the database never throws when DATABASE_URL is unset — the caller
// decides how to degrade.
//
// Connection string comes from backend/.env, e.g.
//   DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/restaurant
// ---------------------------------------------------------------------------

import pg from 'pg';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    const connectionString = (process.env.DATABASE_URL || '').trim();
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Add it to backend/.env, e.g. ' +
        'postgres://USER:PASSWORD@localhost:5432/restaurant'
      );
    }
    pool = new Pool({ connectionString });
    // A pool error (server restarted, network blip) must not take the process
    // down: the next query re-establishes a connection on its own.
    pool.on('error', (err) => {
      console.warn(`[backend] Postgres pool error: ${err.message}`);
    });
  }
  return pool;
}

// True when a connection string is configured at all.
export function hasDatabase() {
  return !!(process.env.DATABASE_URL || '').trim();
}
