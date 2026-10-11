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
npm run start        # build and run the server locally
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
| `DATABASE_PATH`     | SQLite file path; Dokploy uses `/app/data/pixelfleet.sqlite` on a named volume.    |
| `FRONTEND_ORIGIN`   | Optional extra allowed origin for local tooling; not needed in Dokploy.          |
| `FRONTEND_DIST_DIR` | Optional frontend directory override for local tooling.                           |
| `ADMIN_TOKEN`       | Enables protected admin and metrics endpoints.                                    |
| `TRUST_PROXY`       | Defaults to `true`; `false` uses socket client IP and TLS only, ignoring forwarding headers. |

With proxy trust enabled, the backend uses the first `X-Forwarded-For` entry for
client IP and an exact `X-Forwarded-Proto: https` value for secure session cookies.
Direct TLS remains secure in either mode. Cookie issuance and deletion use the same
transport decision. Set `TRUST_PROXY=false` for direct local HTTP development.
Production Compose fixes it to `true` for the documented proxy topology; the local
container override sets it to `false`. Verify the actual proxy configuration and
backend access paths as described in [the deployment guide](docs/dokploy.md#proxy-configuration-evidence).

Legal page details are configured at frontend build time with public `VITE_LEGAL_*` variables.
For Dokploy, use the root `.env.example` in the Compose service's Environment tab;
Compose forwards these values to the Docker build. For local builds, use the template
in `apps/frontend/.env.example`. Real `.env*` files stay out of Git and Docker's build context.

## Production Deployment with Dokploy

Production runs through Dokploy using the root `docker-compose.yml` and multi-stage
`Dockerfile`. One Node.js 24 container serves the built React app, `/api/*`, and `/ws`
from the same origin. SQLite is stored on the persistent `pixelfleet-data` volume.
The image runs as a non-root user and includes a healthcheck and graceful shutdown.

Create a Dokploy **Docker Compose** service from this repository, set the Compose
path to `./docker-compose.yml`, and configure its Environment using `.env.example`.
Add your HTTPS domain for service `pixelfleet` on container port `3001`, path `/`.
Run exactly one instance; active matches are kept in memory and end on redeployment.

See [the Dokploy deployment guide](docs/dokploy.md) for the complete setup, DNS,
configuration, backup/restore, and verification steps.

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
