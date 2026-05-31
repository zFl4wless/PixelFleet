# Pixel Fleet

Pixel Fleet is a browser multiplayer Battleship game with passwordless guest accounts, server-authoritative game rules, WebSocket matchmaking, SQLite persistence, and an 8-bit/pixel-art React UI.

## Project Layout

- `apps/backend`: Node.js HTTP/WebSocket server, guest sessions, SQLite persistence, matchmaking, match state.
- `apps/frontend`: Vite + React client with local 8-bit component wrappers inspired by 8bitcn/21st.dev.
- `packages/shared`: Pure, testable Battleship rules, XP/level helpers, and shared types.
- `tests`: Vitest coverage for the shared game rules.

## Run

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend API/WebSocket: `http://localhost:3001`

The Vite dev server proxies `/api` and `/ws` to the backend so HttpOnly guest-session cookies work in local development.

## Production

```bash
npm install
npm start
```

`npm start` builds the shared package, backend, and frontend, then starts one Node.js server. The server:

- listens on `process.env.PORT` when provided by the host,
- serves the built React app from `apps/frontend/dist`,
- exposes `/api/*` and `/ws` from the same origin, which keeps cookies and WebSockets simple behind HTTPS.

For Infomaniak Node.js hosting, select Node.js 24 or newer because the backend uses Node's built-in SQLite module. If your plan only offers older Node versions, migrate the persistence layer to Infomaniak's MariaDB/MySQL before going public.

Useful environment variables:

- `PORT`: hosting-assigned port.
- `DATABASE_PATH`: optional SQLite file path. Choose a persistent writable path on the host.
- `FRONTEND_ORIGIN`: optional extra CORS origin for split frontend/backend deployments.
- `FRONTEND_DIST_DIR`: optional override for the built frontend directory.
- `ADMIN_TOKEN`: enables protected admin and metrics endpoints.
- `TRUST_PROXY`: defaults to `true`; set to `false` only when the Node process is directly exposed and no trusted reverse proxy sets `X-Forwarded-For`.

## Public-Hosting Hardening

The server includes single-process hardening suitable for small public playtests:

- HTTP rate limit: `HTTP_REQUESTS_PER_MINUTE` (default `240` per IP).
- Guest account creation limit: `GUEST_LOGINS_PER_HOUR` (default `12` per IP).
- WebSocket connect limit: `WS_CONNECTS_PER_MINUTE` (default `30` per IP).
- Active WebSocket cap: `MAX_WS_PER_IP` (default `20` per IP).
- WebSocket action limits: `WS_MESSAGES_PER_10S` (default `120`), `QUEUE_ACTIONS_PER_MINUTE` (default `12`), `FIRE_ACTIONS_PER_10S` (default `120`).
- Request body cap and WebSocket payload cap: `MAX_WS_PAYLOAD_BYTES` defaults to `4096`.
- Origin checks for state-changing HTTP requests and WebSocket upgrades.
- Security headers for the production server.

Monitoring:

- Public health: `GET /api/health`.
- Admin JSON status: `GET /api/admin/status`.
- Admin JSON metrics: `GET /api/admin/metrics`.
- Admin Prometheus metrics: `GET /metrics`.

Admin CLI:

```bash
ADMIN_TOKEN=change-me PIXELFLEET_URL=https://your-domain.example npm run admin -- status
ADMIN_TOKEN=change-me PIXELFLEET_URL=https://your-domain.example npm run admin -- metrics
ADMIN_TOKEN=change-me PIXELFLEET_URL=https://your-domain.example npm run admin -- reset runtime --yes
ADMIN_TOKEN=change-me PIXELFLEET_URL=https://your-domain.example npm run admin -- reset sessions --yes
ADMIN_TOKEN=change-me PIXELFLEET_URL=https://your-domain.example npm run admin -- reset stats --yes
ADMIN_TOKEN=change-me PIXELFLEET_URL=https://your-domain.example npm run admin -- reset accounts --yes
```

Reset scopes:

- `runtime`: clears queue, active matches, sockets and in-memory limit state.
- `sessions`: invalidates guest sessions and clears runtime state.
- `stats`: resets XP and stats while keeping guest accounts.
- `accounts`: deletes all guest accounts and sessions.

## Notes

- Guest login never looks up users by username. Usernames are display names only.
- Session cookies store a random token; the database stores only a SHA-256 token hash.
- Deleting cookies/browser data loses access to the guest account by design.
- The client never receives hidden enemy ship positions. Shots and match transitions are validated on the server.
