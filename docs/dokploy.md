# Dokploy deployment

Pixel Fleet is deployed as one Docker Compose service, `pixelfleet`. The container
serves the built frontend, `/api/*`, and `/ws` on port **3001**. Dokploy's Traefik
proxy terminates HTTPS and forwards traffic to that port. No separate frontend
deployment, external database, or custom Traefik labels are needed.

## Create the deployment

1. Push the prepared repository changes to your deployment branch.
2. In your Dokploy project, create a **Docker Compose** service. Choose **Compose**,
   not **Stack** (Stack cannot build this Dockerfile).
3. Connect this Git repository and select the deployment branch. Set **Compose Path**
   to `./docker-compose.yml`; the build context is the repository root.
4. Paste the root [`.env.example`](../.env.example) into **Environment** and replace
   the legal-page placeholders with your public details. Generate an admin token
   with `openssl rand -hex 32` and put it in `ADMIN_TOKEN` if you want admin access.
   An empty token keeps admin endpoints disabled.
5. In **Domains**, add your domain with **Service Name** `pixelfleet`, **Container Port**
   `3001`, and **Path** `/`. Enable HTTPS with Let's Encrypt and the HTTP-to-HTTPS
   redirect. Preserve the original Host header (the default); origin checks and
   session cookies use the public domain. This single route also covers `/api` and
   WebSocket upgrades at `/ws`.
6. Point the domain's DNS A record at the Dokploy server. Add an AAAA record only if
   that server is reachable over IPv6. Remove obsolete web-hosting records for this
   domain, leaving unrelated records such as email records in place.
7. Deploy. Confirm the container becomes **healthy**, then run the checks below.
   You can enable Dokploy AutoDeploy after the first successful deployment.

Dokploy writes the Environment settings into a `.env` file beside the Compose
file. The Compose configuration explicitly forwards runtime settings to Node and
public `VITE_LEGAL_*` values as Docker build arguments. The Docker context excludes
all `.env*` files, local databases, Git metadata, and local build outputs.

`VITE_LEGAL_*` values are visible in the browser bundle. Changes require a rebuild
and redeploy. `ADMIN_TOKEN` is supplied only at runtime. For hosting-provider details,
use the company running your server and its actual region, rather than Dokploy's
name: Dokploy is the deployment software.

## Persistence and redeployments

The Compose named volume `pixelfleet-data` is mounted at `/app/data` and stores
`pixelfleet.sqlite`, including its SQLite WAL files. Its actual Docker name is
prefixed by Dokploy's Compose project name. Normal restarts and redeployments reuse
it. Keep that project identity stable; deleting the volume or using `down --volumes`
deletes the stored accounts, sessions, and stats.

Run **exactly one instance** on one server. Matchmaking, active matches, and
reconnect timers live in memory. Redeployments briefly interrupt service and end
ongoing matches; existing accounts, login sessions, and completed-match stats
survive. Do not enable overlapping/rolling replicas or horizontal scaling.

The image runs as the `node` user (UID/GID 1000), with a read-only root filesystem.
A new named volume automatically inherits the writable data directory's ownership.
If importing an existing database backup, stop the service first, restore a
consistent SQLite snapshot into this volume as `pixelfleet.sqlite`, and ensure
UID/GID 1000 owns the restored files. Restart and check `/api/me` with an existing
browser session if retaining guest accounts matters.

Use Dokploy **Volume Backups** for `pixelfleet-data` with your configured backup
destination. Stop the service while taking/restoring a raw volume backup so the
database and WAL files form a consistent snapshot. For live backups, use SQLite's
online backup mechanism instead of copying just the `.sqlite` file. Verify a restore
into a separate test deployment before relying on backups.

## Runtime behavior

- Node.js 24 builds and runs the app. The final image contains built artifacts and
  backend production dependencies; no build is performed during startup.
- The Docker healthcheck probes `/api/health` every 30 seconds. Visitor rate limits
  cannot make these probes return 429. Production startup also requires the built
  frontend's `index.html`.
- SIGTERM/SIGINT stops accepting connections, closes WebSockets with code 1012
  (server restart), clears match timers, and closes SQLite. Shutdown has a 10-second
  limit within Compose's 15-second stop grace period.
- `TRUST_PROXY=true` trusts Dokploy's forwarded client IP/protocol headers for rate
  limits and secure cookies. Port 3001 is internal and is not published on the host.
- Container logs rotate at 10 MB with three files retained. Adjust this and the
  server/proxy log configuration to match your stated retention policy.
- Optional rate-limit overrides are listed in `.env.example`. `PORT`,
  `DATABASE_PATH`, and `NODE_ENV` are fixed by the production Compose configuration.

## Verify after deployment

```bash
curl --fail https://YOUR_DOMAIN/api/health
curl --fail --head https://YOUR_DOMAIN/
curl --fail --head https://YOUR_DOMAIN/legal-notice/
curl --fail --head https://YOUR_DOMAIN/privacy-policy/
```

Expect health JSON with `ok: true`, the frontend at `/`, and `X-Robots-Tag` on the
legal pages. Check the public legal pages contain the supplied operator and hosting
details. Open two browser sessions, create guest accounts, and finish a match. In
browser developer tools, verify `/ws` uses `wss://` and upgrades with HTTP 101, and
the `pf_session` cookie has `HttpOnly`, `SameSite=Lax`, and `Secure`.

From a local checkout with dependencies and the shared package built:

```bash
SMOKE_BASE_URL=https://YOUR_DOMAIN npm run smoke:match
PIXELFLEET_URL=https://YOUR_DOMAIN ADMIN_TOKEN=YOUR_TOKEN npm run admin -- status
```

The match smoke test creates two guest accounts and plays a full match. Run it on
a test deployment first. Confirm guest login/session access and stats survive a
redeployment. Admin requests without the configured token must return 401 (or 503
when admin access is disabled).

## Local container verification

```bash
cp .env.example .env
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose exec pixelfleet node scripts/healthcheck.mjs
docker compose logs pixelfleet
docker compose down
```

The production Compose file does not publish a port. For local browser testing,
create a temporary override file outside the repository:

```yaml
services:
  pixelfleet:
    ports:
      - "127.0.0.1:3001:3001"
    environment:
      TRUST_PROXY: "false"
```

Run `docker compose -f docker-compose.yml -f /path/to/override.yml up -d --wait`
and open `http://localhost:3001`. Use those same `-f` arguments for subsequent
Compose commands, including `down`. Keep the volume to test persistence.

## References

- [Dokploy Docker Compose and environment variables](https://docs.dokploy.com/docs/core/docker-compose)
- [Dokploy Compose domain routing](https://docs.dokploy.com/docs/core/docker-compose/domains)
