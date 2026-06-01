# Pixel Fleet

Pixel Fleet is an 8-bit browser multiplayer Battleship game. It combines guest accounts, real-time WebSocket matchmaking,
server-authoritative game rules, persistent stats, and a compact pixel-art React UI.

## Features

- Real-time multiplayer Battleship matches.
- Passwordless guest accounts backed by HttpOnly session cookies.
- Server-authoritative ship placement, shots, turn handling, and match results.
- XP, levels, win/loss stats, hit rate, and ships-sunk tracking.
- WebSocket reconnection handling for active matches.
- SQLite persistence with hashed session tokens.
- Built-in public-playtest hardening: rate limits, origin checks, security headers, and admin-only metrics.
- Configurable Legal Notice and Privacy Policy pages for public deployments.

## Tech Stack

- **Frontend:** React 19, Vite, TypeScript, CSS.
- **Backend:** Node.js 24, native HTTP server, WebSocket server, built-in SQLite.
- **Shared package:** TypeScript game rules, XP helpers, and shared message types.
- **Tests:** Vitest.

## Repository Layout

```text
apps/backend      Node.js HTTP/WebSocket server, matchmaking, persistence, admin endpoints
apps/frontend     Vite + React client and pixel-art UI
packages/shared   Shared Battleship rules, XP helpers, and TypeScript types
scripts           Maintenance, smoke-test, and admin CLI helpers
tests             Vitest coverage for game and server behavior
```

## Getting Started

Pixel Fleet requires Node.js 24 or newer.

```bash
npm install
npm run dev
```

Local development URLs:

- Frontend: `http://localhost:5173`
- Backend API/WebSocket: `http://localhost:3001`

The Vite dev server proxies `/api` and `/ws` to the backend so guest-session cookies work from the local frontend
origin.

## Useful Scripts

```bash
npm run dev          # start backend and frontend for local development
npm run build        # build shared package, backend, and frontend
npm run start        # build and run the production server
npm run serve        # run the already-built production server
npm run test         # run Vitest tests
npm run typecheck    # run TypeScript project checks
npm run smoke:match  # run a basic end-to-end match smoke test
```

## Configuration

Backend runtime configuration:

| Variable            | Purpose                                                                           |
|---------------------|-----------------------------------------------------------------------------------|
| `PORT`              | HTTP/WebSocket server port.                                                       |
| `DATABASE_PATH`     | Optional SQLite file path for persistent hosting.                                 |
| `FRONTEND_ORIGIN`   | Optional extra CORS origin for split frontend/backend deployments.                |
| `FRONTEND_DIST_DIR` | Optional override for the built frontend directory.                               |
| `ADMIN_TOKEN`       | Enables protected admin and metrics endpoints.                                    |
| `TRUST_PROXY`       | Defaults to `true`; set to `false` when no trusted proxy sets forwarding headers. |

Legal page details are configured at frontend build time with `VITE_LEGAL_*` variables. The public repository keeps only
placeholders in `apps/frontend/.env.example`; real contact details should be provided through deployment secrets or an
uncommitted `apps/frontend/.env.production` file.

## Production Deployment

`npm start` builds the workspace and starts one Node.js server. In hosted environments with a separate build step, use
`npm run serve` as the start command so restarts do not rebuild the project. The production server serves the built React
app from `apps/frontend/dist` and exposes `/api/*` and `/ws` from the same origin.

For public deployments:

- Use Node.js 24 or newer.
- Store the SQLite database on persistent storage by setting `DATABASE_PATH`.
- Set `ADMIN_TOKEN` before exposing admin endpoints.
- Set the `VITE_LEGAL_*` variables during the frontend build so the hosted legal pages contain the correct public
  operator and privacy details.
- Keep private `.env*` files out of Git. The repository intentionally tracks only `.env.example` files.

The production build emits static `/legal-notice/` and `/privacy-policy/` HTML shells with `noindex` robots metadata.
The Node production server also sends `X-Robots-Tag: noindex, nofollow, noarchive` for `/legal-notice` and
`/privacy-policy`.

## Public-Playtest Hardening

Pixel Fleet includes conservative single-process safeguards:

- HTTP rate limit: `HTTP_REQUESTS_PER_MINUTE` (default `240` per IP).
- Guest account creation limit: `GUEST_LOGINS_PER_HOUR` (default `12` per IP).
- WebSocket connect limit: `WS_CONNECTS_PER_MINUTE` (default `30` per IP).
- Active WebSocket cap: `MAX_WS_PER_IP` (default `20` per IP).
- WebSocket action limits: `WS_MESSAGES_PER_10S`, `QUEUE_ACTIONS_PER_MINUTE`, and `FIRE_ACTIONS_PER_10S`.
- Request body and WebSocket payload caps.
- Origin checks for state-changing HTTP requests and WebSocket upgrades.
- Security headers for the production server.

Monitoring endpoints:

- `GET /api/health`
- `GET /api/admin/status`
- `GET /api/admin/metrics`
- `GET /metrics`

Admin endpoints require `ADMIN_TOKEN`.

## Data Model Notes

- Usernames are display names only; guest login never looks up users by username.
- Session cookies store a random token; the database stores only a SHA-256 token hash.
- Clearing browser cookies loses access to the guest account.
- Hidden enemy ship positions are never sent to the client.
- Shots and match transitions are validated on the server.

## Contributing

Bug reports, small improvements, and focused pull requests are welcome. For larger changes, opening an issue first keeps
the discussion easy to follow.

## License

Pixel Fleet is released under the MIT License. See `LICENSE`.
