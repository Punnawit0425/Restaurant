# Restaurant app — single image that builds the React frontend and runs the
# Express + SSE backend, which serves that built frontend on the same origin.
#
# Two stages on purpose: vite, tailwind and the rest of the build toolchain are
# needed to COMPILE the frontend and never to run it. Building in a throwaway
# stage and copying only frontend/dist forward keeps a few hundred MB of build
# tooling — and its CVEs — out of what actually runs in production.

# --- Stage 1: compile the frontend -----------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first so a source change doesn't bust the dependency layer.
COPY frontend/package.json frontend/package-lock.json ./frontend/
# `ci` not `install`: installs exactly what package-lock.json pins, so the image
# is reproducible and a transitive dependency cannot drift between builds.
# Dev dependencies are wanted here — vite is what does the building.
RUN npm --prefix frontend ci

COPY frontend ./frontend
RUN npm --prefix frontend run build

# --- Stage 2: the image that actually runs ---------------------------------
FROM node:22-alpine

WORKDIR /app

# The shop is in Thailand and its day rolls over at 06:00 Thai time. The date
# helpers pin Asia/Bangkok themselves, but every other date the container prints
# — logs, backup filenames, Postgres session time — should read the same clock
# as the till. tzdata is not in the alpine base image, so install it.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Bangkok
ENV NODE_ENV=production
# The platform (Railway/Fly) injects its own PORT at runtime; this is just a
# sensible default for `docker run` locally.
ENV PORT=3001

COPY backend/package.json backend/package-lock.json ./backend/
# --omit=dev: nothing in backend/ is a dev dependency today, and this keeps it
# that way if one is ever added.
RUN npm --prefix backend ci --omit=dev

COPY backend ./backend
# server.js serves this from path.join(__dirname, '..', 'frontend', 'dist').
COPY --from=build /app/frontend/dist ./frontend/dist

# NOTE: this deliberately runs as root. The obvious hardening is `USER node`,
# but DATA_DIR points at a platform-mounted volume (/data on Railway) that is
# mounted root-owned at runtime — a build-time chown cannot reach it, so a
# non-root process would fail to write data.json and the uploaded menu photos,
# taking staff logins and images down with it. Revisit only alongside an
# entrypoint that fixes ownership after the mount.

EXPOSE 3001

# Start the backend, which also serves frontend/dist.
CMD ["npm", "--prefix", "backend", "run", "start"]
