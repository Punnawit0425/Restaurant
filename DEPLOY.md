# Deploying the Restaurant app to Railway (no GitHub)

This deploys the whole app — frontend + backend + database — to Railway, straight
from your laptop. Estimated time: **~30–45 min** for a first run.

## Mental model

Your app has three parts:

- **Frontend** — the screens people tap. Compiled into plain files, then served
  *by the backend* (so they act as one website on one address).
- **Backend** — the "brain": remembers orders, pushes live updates to every open
  screen (SSE), handles logins.
- **Database (Postgres)** — the filing cabinet: menu, orders, stock.

Two kinds of saved data:

- **In Postgres** → menu, orders, stock.
- **On a disk file (`data.json`) + `uploads/` folder** → staff logins, shop
  settings, payroll, time-clock, and uploaded menu photos.

The disk stuff is why we need a **Volume** (a permanent drawer that survives
redeploys). The database is handled by Railway's managed Postgres.

---

## Code changes (ALREADY DONE — listed so you know what's in place)

- `backend/server.js` — reads `DATA_DIR` env var to decide where `data.json`,
  backups, and `uploads/` live. Locally it defaults to the backend folder; in
  production we point it at the Volume.
- `backend/server.js` — now serves the built frontend (`frontend/dist`) and falls
  back to `index.html` for client routes, so the whole app is ONE origin. No CORS
  or proxy to configure in production.
- `Dockerfile` + `.dockerignore` — builds the frontend and runs the backend the
  same way everywhere.

Nothing else in the code needs changing.

---

## Prerequisites

- Node + npm installed (you have these).
- `psql` and `pg_dump` installed locally (they come with Postgres; check with
  `psql --version`).
- Your **local** Postgres connection string, e.g.
  `postgres://USER:PASS@localhost:5432/restaurant`
  (only needed if you want to bring your existing menu/data across).

---

## Step 1 — Install the Railway CLI and log in

```bash
npm i -g @railway/cli
railway login
```

`login` opens a browser to authorize. This CLI is how you deploy without GitHub.

## Step 2 — Create the project

```bash
cd /Users/punnawit/Documents/Restaurant
railway init
```

Give it a name when prompted. This creates an empty project on Railway linked to
this folder.

## Step 3 — Add managed Postgres

In the Railway dashboard for this project: **New → Database → PostgreSQL**.

Railway runs Postgres for you (with automatic backups). You do NOT install or
manage Postgres yourself. It exposes two connection strings in the DB service's
**Variables** tab:

- `DATABASE_URL` — private, for the app to use (Step 6).
- `DATABASE_PUBLIC_URL` — public, for you to connect from your laptop (Step 4).

## Step 4 — Load your schema + data into that database

Railway's new database is empty. Give it your tables and menu data.

**A) Bring your existing data across (recommended):**

```bash
pg_dump "postgres://USER:PASS@localhost:5432/restaurant" \
  | psql "PASTE_DATABASE_PUBLIC_URL_HERE"
```

**B) Or start fresh (empty tables only):**

```bash
psql "PASTE_DATABASE_PUBLIC_URL_HERE" \
  -f schema/menu_schema.sql -f schema/orders_schema.sql -f schema/stock_schema.sql
```

(The `orders` table also auto-creates on first boot, but loading all three is
safe and complete.)

## Step 5 — Add a persistent Volume  ⚠️ don't skip

In the **app service** (not the database): **Settings → Volumes → New Volume**,
mount path **`/data`**.

This is where `data.json` (staff, settings, payroll, time-clock) and uploaded
menu photos will live. Without it, every redeploy wipes them.

## Step 6 — Set environment variables

In the **app service → Variables**, add:

```
DATABASE_URL     = ${{Postgres.DATABASE_URL}}
DATA_DIR         = /data
ALLOWED_ORIGINS  = https://YOUR-APP.up.railway.app
AUTH_SECRET      = <paste output of: openssl rand -hex 32>
```

- `DATABASE_URL` — the `${{Postgres.DATABASE_URL}}` reference points at the DB you
  made in Step 3, over Railway's private network (no SSL setup needed).
- `DATA_DIR = /data` — tells the app to store the file + photos on the Volume.
- `AUTH_SECRET` — signs staff session tokens. MUST be set and stable: if it's
  missing the app generates a random one at boot, so **every redeploy logs out
  all staff**. Generate once with `openssl rand -hex 32` and never change it.
- `ALLOWED_ORIGINS` — your app rejects requests from web addresses it doesn't
  recognize. It must include your own public address, or logins and orders fail
  with a 403. You get the real address in Step 7 — set a placeholder now, fix it
  after.

## Step 7 — Deploy

```bash
railway up
```

Railway builds (installs deps, compiles the frontend) and starts the app. First
build takes ~5–10 min.

Then: **Settings → Networking → Generate Domain** to get your public URL.

Now go back to **Variables**, put the real URL into `ALLOWED_ORIGINS`, and
redeploy:

```bash
railway up
```

(Yes — two builds. The first gives you the domain, the second applies it.)

---

## After it's live — verify

1. **Open the URL on your phone** → the menu should load.
2. **Log in as owner** → re-create staff accounts and re-upload menu photos. This
   is a one-time thing because the Volume started empty; after this they persist.
3. **Open two tabs (a customer + the staff screen) and place a test order** → it
   should appear on the staff screen instantly. This confirms live updates
   survived the move.

---

## Troubleshooting

- **Logins/orders return 403** → `ALLOWED_ORIGINS` doesn't match your real domain.
  Fix the value (exact `https://…`, no trailing slash) and redeploy.
- **Menu is empty** → Step 4 didn't run against the right database, or ran against
  the private URL from your laptop (use `DATABASE_PUBLIC_URL` from your machine).
- **Photos gone after a redeploy** → the Volume isn't mounted at `/data`, or
  `DATA_DIR` isn't set to `/data`.
- **Live updates don't push** → check the app logs (`railway logs`) for the SSE
  connection; confirm you're testing over the public HTTPS URL, not a stale tab.
- **`pg` SSL/cert error** → only happens if the app points at a *public* Postgres
  URL. Use the `${{Postgres.DATABASE_URL}}` private reference and it won't.

## Handy commands

```bash
railway logs        # live server logs
railway variables   # list env vars
railway up          # redeploy after any change
railway open        # open the project dashboard
```
