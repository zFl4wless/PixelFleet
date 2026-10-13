# Dokploy deployment

Pixel Fleet is deployed as one Docker Compose service, `pixelfleet`. The container
serves the built frontend, `/api/*`, and `/ws` on port **3001**. In the intended
topology, Dokploy's Traefik proxy terminates HTTPS and forwards traffic to that
port. No separate frontend deployment, external database, or custom Traefik labels
are needed.

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
7. Configure and verify the release gate below before enabling AutoDeploy. Deploy
   only through that build path. Confirm the container becomes **healthy**, then
   run the public-route checks below.

Dokploy writes the Environment settings into a `.env` file beside the Compose
file. The Compose configuration explicitly forwards runtime settings to Node and
public `VITE_LEGAL_*` values as Docker build arguments. The Docker context excludes
all `.env*` files, local databases, Git metadata, and local build outputs.

`VITE_LEGAL_*` values are visible in the browser bundle. Changes require a rebuild
and redeploy. `ADMIN_TOKEN` is supplied only at runtime. For hosting-provider details,
use the company running your server and its actual region, rather than Dokploy's
name: Dokploy is the deployment software.

## Required release gate (TD-03, TD-08)

The release gate is part of the Dockerfile, rather than a separate optional CI
job. Both the default Docker build and Compose's explicit `build.target: runtime`
depend on this sequence:

1. Node **24** (`node:24-bookworm-slim`), with all workspace dependencies installed
   from `package-lock.json` by `npm ci`.
2. `npm run verify`: the complete `npm test` suite, root `npm run typecheck`, then
   `npm run build`. Each command must succeed before the next runs. Tests are now
   included in the build context. These checks run with `--network=none`, using
   only local services and temporary test databases.
3. A separate `npm ci --omit=dev` installs only backend/shared runtime dependencies.
   `runtime-base` assembles the production filesystem, user, command and healthcheck.
4. `runtime-check` starts that compiled backend as UID 1000 with a fresh SQLite
   fixture in a temporary filesystem and an ephemeral local port. It runs the
   existing healthcheck, the unchanged complete `scripts/smoke-match.mjs`, a second
   healthcheck, and checks graceful shutdown. External networking is disabled.
5. `browser-tools` prepares the lockfile-pinned Playwright Chromium headless shell
   and required Debian libraries with `npm run browser:install`. Browser downloads
   and OS package installation happen here, before execution.
6. `browser-check` runs `npm run browser:test` with `--network=none`, the built
   frontend, real backend processes and per-test temporary SQLite databases. Five
   Chromium scenarios must succeed, without test retries. This supplements the
   existing React mount tests and protocol smoke.
7. The final `runtime` target depends on **both** successful checks. A failed
   source/browser test, typecheck, build, healthcheck, smoke or shutdown prevents image export.
   The check driver and smoke script are read-only build mounts; the final image
   contains neither these scripts, test files, test data, browsers, browser-only
   system packages nor installed project dev dependencies.

Supported commands from the repository root:

```bash
# Optional fast source check outside Docker; use Node 24.15+ for the DOM tests.
npm ci
npm run verify

# Complete required image gate; neither command deploys anything.
docker build --progress=plain --target runtime -t pixelfleet:checked .
docker compose --progress plain build pixelfleet

# Re-run all steps instead of reusing successful checks for identical inputs.
docker compose --progress plain build --no-cache pixelfleet
```

BuildKit is required for the stage mounts and network isolation. It fails the
build if unsupported; there is no fallback that skips checks. Normal build caching
can reuse successful steps for identical inputs. Source, tests, manifests, lockfile,
public build arguments and check-script changes invalidate their dependent checks.
The lockfile fixes npm dependency resolution; the Node 24 base tag still receives
patch updates, so this is not a claim of bit-identical images across base updates.

Do not deploy intermediate targets (`build`, `browser-tools`, `browser-check`,
`runtime-base`, `runtime-check`), use
an alternate Dockerfile, replace the Compose build with an unverified `image:`,
or fall back to an old image after a build failure. Deliberate configuration changes
can bypass any repository gate; restrict and review them as described below.

### External settings to apply and verify

These settings cannot be established by editing this repository. No live Dokploy
or repository settings have been accessed or verified for TD-03.

1. In Dokploy, select **Docker Compose / Compose**, the intended Git repository and
   deployment branch, `./docker-compose.yml`, and the repository root as context.
   Use a BuildKit-capable builder. Keep the checked-in Dockerfile and target `runtime`.
2. Inspect the actual deployment command. It must build before replacing the
   service and stop on build failure. Preserve Dokploy's project/path flags and use
   `compose -p YOUR_DOKPLOY_PROJECT -f YOUR_COMPOSE_PATH up -d --build --remove-orphans`
   in its Command field if a custom command is needed. Dokploy adds the leading
   `docker`; a custom command replaces its default. Do not use `--no-build` or a
   command that ignores a failing build. Do not change the existing production
   project identity or delete its data volume while configuring this.
3. Before AutoDeploy, use a separate Dokploy test service with its own project,
   volume and no production domain/data. Deploy a commit with a deliberately
   failing browser assertion (see the TD-08 probe below). Verify failed deployment status, no replacement of the running
   test-service container, and no fallback to a previous image reported as success.
   Remove the probe, deploy that new commit and inspect successful gate logs plus
   container health. Check the displayed Git commit against the deployed revision.
4. Protect the deployment branch in the repository host: disallow direct/force
   pushes and require reviewed pull requests. Have maintainers review changes to
   `Dockerfile`, `.dockerignore`, `docker-compose.yml`, package manifests/lockfile,
   `scripts/verify-runtime.mjs`, `scripts/smoke-match.mjs`, `playwright.config.ts` and tests. Limit who can
   change Dokploy commands, branch selection and image sources. This implementation
   adds no CI status name; do not configure a nonexistent required status check.
5. Enable AutoDeploy only after the staging failure/success check confirms these
   effective settings. A separate CI job may invoke the same build, but does not
   replace the required Docker/Dokploy gate.

The repository gate and local Docker behavior are implemented and locally proven.
An active production deployment block remains **externally unverified** until the
steps above are completed with access to the actual service and repository host.

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

### Schema migration, backups and rollback (TD-05)

This release introduces SQLite schema version **1**, recorded in `PRAGMA
user_version`. Startup migrates both an empty database and the original
unversioned database (version 0) in one `BEGIN IMMEDIATE` transaction. Existing
users, sessions, XP and statistics remain intact. The new `match_completions`
table and version change commit together. Failed migration rolls back and stops
startup; restarting after correcting the cause retries it. Version 1 is a no-op
on subsequent starts. A version above 1 stops startup before schema or journal
configuration changes; do not lower the version manually to bypass this guard.

Before upgrading an existing deployment:

1. Disable automatic deployment temporarily and stop the sole application instance
   using Dokploy's Stop action (or `docker compose stop pixelfleet` in the actual
   deployment project). Pending/uncommitted match decisions are in memory and
   cannot survive this stop. Keep the existing project and volume identity.
2. Create a consistent full backup of the stopped `pixelfleet-data` volume using
   Dokploy Volume Backups. Include the database and any WAL/SHM files together;
   copying only a live main database file is not a backup. Record the application
   revision and schema version with the backup, and retain it outside the volume.
3. Restore that backup into a separate test deployment with a new volume. Run the
   checked-in Docker release gate, start the new image against this copy, and
   verify existing accounts, sessions, XP and statistics. The automated migration
   tests cover synthetic legacy databases, not the actual production backup.
4. Deploy the verified image to the stopped original single-instance project,
   following the release gate above. Check startup logs, health and an existing
   session. For a read-only schema/receipt check in the running container:

   ```bash
   docker compose exec -T pixelfleet node --input-type=module <<'NODE'
   import { DatabaseSync } from 'node:sqlite';
   const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
   console.log(db.prepare('PRAGMA user_version').get());
   console.log(db.prepare('SELECT COUNT(*) AS completed_matches FROM match_completions').get());
   db.close();
   NODE
   ```

If startup fails during migration, preserve the failed database and logs, correct
the cause or restore the tested backup while stopped, and retry. Do not drop tables
or delete receipt rows as a repair. There is no automatic down-migration.

Older application code does **not** know this version guard or the completion
ledger. Running it against the migrated volume can create matches without receipts
and reintroduce partial/double rewards, even though the extra table is additive.
A rollback to pre-TD-05 code therefore requires a stopped service, an archive of
the current complete database, and restoration of the matching pre-upgrade backup;
it loses all subsequent progress and reinstates the old defects. Prefer a forward
fix. Never mix an older receipt table with newer account totals or restore selected
tables independently. Restoring an older snapshot also restores only the protection
present at that snapshot; there is no historical replay/recovery mechanism.

Each committed match stores one immutable receipt keyed by match UUID: both account
UUIDs, winner, reason, shot/hit/sunk counters, awarded XP and completion transaction timestamp. It
does not store boards, usernames or session tokens. Replays compare the canonical
decision and cannot award again; changed winner, participants, reason or counters
are rejected. Existing pre-migration aggregates cannot be assigned retrospective
receipts because the old schema stored no match IDs.

Receipt storage grows linearly with the total number of completed matches and has
**no automatic expiry**. Ten-minute in-memory result expiry, acknowledgement and
every admin reset (`runtime`, `sessions`, `stats`, `accounts`, `all`) preserve it.
There is deliberately no cascading foreign key from receipts to deleted accounts;
their UUIDs remain in the ledger after account reset. These UUIDs are still data
associated with accounts, not anonymous records. Plan volume/backup capacity and
the corresponding retention policy explicitly. Any future compaction or deletion
must retain an equivalent durable duplicate/conflict guard before removing rows.

### Failed match completion and administrative resets (TD-05)

Both player updates and the receipt commit atomically. Account and session creation
also commit together. Only a successful match commit publishes updated profiles,
results and completion metrics and starts `FINISHED_MATCH_RETENTION_MS`.

On a match write failure, the final decision and counters are frozen, including a
last shot already applied in memory. Play stops (`currentTurnUserId: null`), clients
receive a saving/error message, and the backend makes at most **three total
attempts**, with **1000 ms** between attempts. Disconnects, reconnects and further
actions cannot change the winner or restart this budget. Conflicting persisted
decisions stop immediately without retries. No client invalid-action penalty is
charged for these storage failures. The protocol keeps the prior placing/playing
phase with a stopped turn until commit; no successful result is announced early.

After the third failure the match remains blocked without a retry timer. Inspect
the authenticated admin metrics' recent error events (match ID, attempt and error),
resolve the storage issue, and use the existing administrative runtime reset to
discard blocked state. That reset closes **all** sockets and discards all active
matches; it does not retry or award the failed match. The in-memory event history
and pending decision are not durable. Shutdown/restart likewise cancels pending
attempts; this release does not recover active/pending matches or result views
after a process restart. A commit that succeeded before a crash remains protected
in SQLite even if clients never received its result.

All database reset scopes first clear runtime state. **`stats` now also closes
sockets and removes active/pending matches and retained results**, while preserving
accounts and sessions. This prevents a pending completion from awarding after the
reset or a retained result from showing old totals again. Resets of accounts/all
delete users/sessions but keep completion receipts. Retrying an old receipt after
a stats reset leaves the reset totals unchanged; deleted accounts are never
recreated. If the database reset itself fails, the runtime has already been
cleared; inspect the error before retrying. The general HTTP error mapping remains
outside TD-05.

## Runtime behavior

- Node.js 24 builds and runs the app. The final image contains built artifacts and
  backend production dependencies; no build is performed during startup.
- The Docker healthcheck probes `/api/health` every 30 seconds. Visitor rate limits
  cannot make these probes return 429. Production startup also requires the built
  frontend's `index.html`.
- SIGTERM/SIGINT stops accepting connections, closes WebSockets with code 1012
  (server restart), clears match timers, and closes SQLite. Shutdown has a 10-second
  limit within Compose's 15-second stop grace period.
- `TRUST_PROXY=true` uses the first `X-Forwarded-For` entry for client IP and an
  exact `X-Forwarded-Proto: https` value for secure cookies. Direct socket TLS also
  marks cookies secure. Cookie issuance and deletion use the same decision.
- `TRUST_PROXY=false` ignores forwarding headers for both client IP and cookie
  security, using only the socket's remote address and TLS state. Plain local HTTP
  works without `Secure`; direct TLS retains `Secure` in both modes.
- The Dockerfile defaults `TRUST_PROXY` to `true`; production Compose fixes it to
  `true` for this proxy topology. Port 3001 has no host-port publication in the
  checked-in Compose file. The local container override below sets trust to `false`.
- Container logs rotate at 10 MB with three files retained. Adjust this and the
  server/proxy log configuration to match your stated retention policy.
- Optional rate-limit overrides are listed in `.env.example`. `PORT`,
  `DATABASE_PATH`, and `NODE_ENV` are fixed by the production Compose configuration.
- One server-owned interval prunes expired entries from all HTTP/upgrade and hub
  rate limiters every **30000 ms (30 seconds)**, including idle accounts/IPs. It
  removes only entries whose fixed window has ended; it does not evict live keys.
  Disconnect, reconnect and socket replacement preserve quotas. An administrative
  runtime reset intentionally clears hub quotas/error budgets as before, while
  leaving HTTP/upgrade quotas and the one cleanup interval running. Shutdown or
  server close stops that interval; no per-key cleanup timers are created.
- Invalid actions use a fixed **60000 ms (60-second)** window per account, starting
  at its first rejected action. The **eighth** rejection in that window closes
  the connection with code 4008; subsequent rejections do not extend the window.
  At the exact deadline, the next rejection starts a new count. Oversized messages
  and message-rate overflow still close immediately, regardless of this count.
  Expired budgets are pruned by the same interval without further client activity.
  These durations and the error threshold are fixed, not new environment overrides.
  Retention is limited to the window plus at most one cleanup interval under a
  running event loop; this is not a cap on simultaneously live keys. In particular,
  guest-login quota entries still retain their existing one-hour window.
- `FINISHED_MATCH_RETENTION_MS` controls in-memory finished-result retention in
  **milliseconds from the successful match commit**. Default and maximum: **600000 (10 minutes)**.
  Set an integer from **1 through 600000** to shorten it; invalid values stop
  backend startup. Empty/unset uses the default. Expiry runs on a timer even with
  no connected clients. Disconnects do not acknowledge results; reconnects do not
  renew the deadline. Both participants explicitly acknowledging via `leave_match`
  removes an entry earlier. Statistics and XP already stored in SQLite are unchanged.
  This is a runtime setting; restart the backend to apply a changed value.
- Active matches and retained results are separate. On reconnect, an active match
  takes precedence, then an existing queue entry, then the newest unacknowledged
  retained result. The generic `leave_match` action also takes the active match
  first; there is no explicit match-ID result-history API. Each connection now
  receives the authoritative snapshot described below, including an empty lobby
  after result expiry, restart or queue cancellation.
  Retained results do not survive process restart. The 30-second reconnect grace
  for an active match is unchanged.

## Reconnect snapshots and coordinated releases (TD-06)

Deploy **backend, shared protocol and frontend together** through the existing
single-image release gate. The WebSocket subprotocol is now `pixelfleet.v2`;
the browser and match-smoke client request it explicitly. Preserve the normal
`Sec-WebSocket-Protocol` negotiation through any reverse proxy. Do not combine
old frontend assets with the new backend or roll back just one of these pieces.
HTML remains `no-cache` and hashed JS assets remain immutable; reloading the page
loads the assets referenced by the current image.

The first application message on each supported authenticated socket is
`session_snapshot: { profile, state }` (with `type: "session_snapshot"` on the
wire). `state.kind` is `lobby`, `queue`, or `match`. A match view explicitly reports
phase `placing`, `playing`, `saving`, `save_failed`, or `finished`; only a committed
`finished` view has a result. A lobby or queue snapshot has no residual match view.
Selection is: active match (including blocked persistence), existing queue, newest
unacknowledged result still within TD-02 retention, then lobby. The profile is read
at initialization; reconnect does not renew session or result deadlines.

The server prepares and queues this snapshot synchronously before enabling that
socket's live updates/actions. Later frames use the same ordered WebSocket stream.
There is no separate snapshot fetch that could race an update. The client applies
profile and state together and enables gameplay only after initialization, not at
socket-open or after a profile-only message. Socket identity and account generation
checks still discard late messages, HTTP responses and close callbacks.

A short disconnect preserves an unconfirmed local placement while account ID and
match ID remain the same and the server still permits placement. Confirm/fire,
queue cancellation and result acknowledgement cannot send while initialization is
pending. A different account/match, explicit lobby, confirmed fleet or later phase
discards the old placement editor. A reconnect snapshot exposes only the existing
public boards; it never reveals unshot opponent positions.

`saving` means the TD-05 completion decision is fixed and persistence is being
retried; `save_failed` means those bounded attempts are exhausted/conflicted and
play remains locked. Both have explicit status text and no gameplay controls or
premature result. Commit transitions to `finished` with the updated profiles and
result. Failure handling, reset recovery, reward transactions and the TD-02 timer
starting at commit remain as documented above. A server process restart loses
in-memory matches and retained results; a valid session reconnects to lobby in that
new process. A page reload against a still-running server can recover its current
match or retained result, but never that page's unsubmitted local placement.

**Already open old browsers:** existing sockets are closed by the normal deployment
shutdown. On reconnect an old client that does not offer `pixelfleet.v2` receives a
fixed toast asking it to reload, then close code **4002**. It is not added to the hub
and cannot play against the incompatible protocol. That old JavaScript treats 4002
as a retryable close, so it can keep retrying until the user reloads or closes the
tab; old on-screen state is not authoritative. Retries retain normal quotas and
can temporarily reach 429. Instruct users to reload old tabs after this release and
wait for any retry window if necessary. A current client that sees an unsupported
initial message or 4002 stays unready, shows a reload notice and does not auto-retry.
A reload during placement loses that page's unsubmitted local draft; server-confirmed
fleets remain available if the server process and match are still alive.

The existing Docker gate now includes real React DOM mount tests via the development
dependency `jsdom` (pinned in the lockfile). For local source verification use Node
**24.15 or newer in the 24.x line**; the checked Node 24 Docker base satisfies this.
`npm ci --omit=dev` keeps jsdom, its dependencies and test files out of the runtime.
The smoke client only changed protocol selection and waits for the initial snapshot;
it still plays the same complete match. TD-08 adds the development-only browser
suite described below; Playwright is not a production dependency. Validate public proxy protocol negotiation in
the authorized test deployment before release; that external deployment was not
performed during this local remediation.

## HTTP errors and diagnosis (TD-07)

JSON endpoints require an `application/json` Content-Type (case insensitive;
parameters such as `charset=utf-8` are accepted). The JSON body must be an object.
Guest login requires a string username that passes the existing normalization,
minimum length and reserved-name checks. Omitted usernames still fail the minimum
length check. Admin reset defaults an omitted `scope` to `runtime`; explicit null,
non-string or unknown scopes are rejected. Unknown extra fields remain ignored.

| Status | Meaning |
| --- | --- |
| 400 | Malformed/empty JSON, wrong JSON structure or field types, invalid username/reset scope, malformed cookie encoding or request URL. Public messages are fixed descriptions, never exception details or echoed input. |
| 413 | JSON body exceeds **16384 bytes (16 KiB)**, counting received bytes rather than JavaScript characters. Content-Length is checked early; chunked bodies are also checked. Exactly the limit is permitted. |
| 415 | Missing or unsupported Content-Type on an endpoint reading JSON; form-encoded and text bodies are not supported. |
| 500 | Unexpected storage/programming/filesystem failure: `{"error":"Internal server error.","requestId":"…"}`. No SQL, filesystem path or stack is returned. |

Existing authentication, origin, routing, quota and disabled-admin responses retain
their status/body semantics and headers, including `Retry-After` on 429. These
checks still precede body parsing. An already authenticated guest-login request
still returns its existing profile without reading a new body. Unsupported methods
continue to follow the existing routing behavior.

The HTTP handler generates a fresh UUID for each request, returned as
`X-Request-ID`; a client-supplied ID is ignored. Trusted-origin CORS exposes this
header to browser code. The ID in a generic 500 body matches the header and the
internal error event. It is a correlation key, not an authentication token.
Preparation (security/CORS headers and routing), async input reads and static
file reads are inside the error boundary. If the connection has already closed or
headers have been committed, the server does not attempt a second JSON response;
an unfinished response is terminated instead. A partial static response can
therefore be a truncated 200, not a retroactive 500.

Unexpected HTTP failures become structured events in the **existing**, admin-only
`recentEvents` list (`GET /api/admin/metrics` or `/api/admin/status`). The list holds
at most **50 events of all types**, in memory only, and disappears on restart. HTTP
events contain timestamp, server request ID, an allowlisted method (otherwise
`OTHER`), fixed route category, stage and response state. Diagnosis contains an
error kind, an allowlisted system error code, a bounded numeric SQLite code when
available, and a known backend component basename plus numeric line/column when
available. It omits raw exception messages, full stacks, absolute paths, cookies,
session/admin tokens, Authorization headers, full bodies, usernames, client IPs
and free URLs/query strings. HTTP origin-rejection and reset events also avoid
unfiltered client values. Expected input errors do not add exception events.

This intentionally limited diagnosis may require reproducing a failure in an
isolated environment to determine its exact cause. There is no persistent logging,
new monitoring service or capture of arbitrary thrown values. Other existing event
producers, including the WebSocket protocol, were not redesigned. If storage failure
also prevents the admin endpoint's database gauges, that endpoint can itself return
500; the retained events can be inspected after storage is repaired, if still in
the list. `/api/health` remains a process/readiness probe and does **not** validate
SQLite availability.

The existing `http_requests_total` and `http_errors_total` counters remain. Added
`http_client_errors_total` counts 400–499 and `http_server_errors_total` counts
500–599. Prometheus exposes the same names with prefix `pixelfleet_`. Each response
is registered once and counted once on `finish`; the error handler does not also
increment them. Aborted or truncated responses without `finish` are not completed
HTTP responses and do not increment these counters, though unexpected failures
still create an event. Request IDs and URLs are **not** metric labels. Admin metrics
snapshots are taken before their own response finishes.

## Proxy configuration evidence

The repository does not contain the effective Dokploy/Traefik routing and network
configuration. `TRUST_PROXY=true` does not validate the socket peer against a proxy
allowlist or establish whether incoming forwarding headers were sanitized. Before
relying on this production topology, obtain evidence for the actual deployment:

- The effective HTTPS termination, HTTP-to-HTTPS redirect, public Host routing and
  WebSocket route to container port 3001.
- Which peers and forwarding hops can reach the backend, including other containers
  on its attached networks. The absence of a published host port alone does not
  establish that all reachable peers are trusted proxies.
- How the effective proxy configuration handles client-supplied `X-Forwarded-For`
  and `X-Forwarded-Proto`, including any upstream proxies. Establish that the first
  forwarded client entry and the exact protocol value consumed by Node are authoritative.
- Login and logout cookie attributes on the public HTTPS route and the client IP
  actually used for HTTP and WebSocket quotas in an authorized test deployment.

No proxy peer addresses, trusted network ranges or header-cleaning rules are supplied
here because they must come from the actual deployment. The local SA-06 fix unifies
the application's trust switch; it does not confirm production proxy security.
See [the SA-06 fix status](security/SA-06-FIX-STATUS.md) for the repository evidence,
test status and remaining deployment questions.

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

## Automated Chromium checks (TD-08)

The repository's five scenarios test the **production build**, served by the actual
compiled backend. They cover guest login/lobby/logout; two isolated browser contexts
playing a complete UI match through both result acknowledgements; queue loss and
reconnect; retained placement draft and continued play after reconnect; and a real
backend restart with the same database and still-valid sessions returning to lobby.
Confirmations and shots use role/name selectors and native UI clicks. Fixed legal
placement coordinates make target selection repeatable; the server still chooses
the first turn and validates every action. Test-side native WebSocket references
allow a socket to be closed without reloading away the placement draft. They do
not mock frames, invoke application actions or require production test endpoints.

### Local preparation and commands

Use Node **24.15+ within 24.x**, from the repository root:

```bash
npm ci
npm run verify
# Preparation only: downloads the pinned Chromium headless shell. On Linux this
# also installs required OS libraries and may require package-manager privileges.
npm run browser:install
# Executes against the existing production build; starts only owned local services.
npm run browser:test
# Optional stability/isolation check, with a fresh database and contexts each time.
npm run browser:test -- --repeat-each=3
```

No Vite devserver or previously running backend is used. Each test allocates an
ephemeral port, temporary SQLite/WAL/SHM files and new browser contexts. Restart
reuses only that test's database and port. Fixtures close their contexts, stop and
await their backend processes, then delete their databases; signal handlers also
request cleanup. Forced process/host termination such as SIGKILL cannot guarantee
user-space cleanup. No production database, `.env` file, volume or service is read.

Tests do not install/download browsers. Missing build outputs or Chromium fail
with an explicit setup command; no scenario is silently skipped. `npm run verify`
retains the fast source/React suite and also typechecks the browser code; it does
not execute Chromium. The supported Docker release target always executes both.
The version of `@playwright/test` and its Chromium revision are pinned by the lockfile.
Debian libraries come from the Node 24 Bookworm base and configured Debian security
repositories; as with the base tag, this is not a bit-identical OS snapshot.

### Failure artifacts and diagnostics

`test-results/` is ignored by Git and Docker. On failure, each captain gets a full
page screenshot and retained trace in `test-results/browser/<test>/`, plus bounded
logs from the isolated backend. The HTML report in `test-results/browser-report/`
links those attachments. Success discards traces. To inspect the report locally:

```bash
npx playwright show-report test-results/browser-report --host 127.0.0.1
```

All uncaught JavaScript page errors fail the scenario. Unexpected HTTP failures,
console errors, WebSocket errors and rejected UI actions also fail it. Allowances
are limited to GET `/api/me` returning 401 before guest authentication/after logout,
and connection errors for that test's `/api/me` or `/ws` during its explicit restart.
No blanket exception suppression or test retries are enabled. Traces contain test
cookies and fixture messages: use this harness only with its disposable accounts.
Run invocations sequentially because Playwright cleans the same output directory
at the start of each invocation.

BuildKit reports browser failures and artifact paths in the build log, but a failed
stage is not an exported image and its artifact files are not automatically copied
to the host. To reproduce and retain them in Docker, prepare the diagnostic stage
and mount a local ignored output directory:

```bash
(
  set -eu
  tools_image="pixelfleet-browser-check:$(date +%s)-$$"
  cleanup() { docker image rm "$tools_image" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  trap 'exit 1' INT TERM
  docker build --progress=plain --target browser-tools -t "$tools_image" .
  mkdir -p test-results
  docker run --rm --network none --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=bind,src=$(pwd)/test-results,dst=/app/test-results" \
    "$tools_image" npm run browser:test
)
```

This diagnostic target is **not** a release image. Normal Docker/default/Compose
builds still require `browser-check` and `runtime-check` before the final export.
No additional CI service is required. On the Dokploy builder, allow npm, Debian
package repositories and Playwright's browser CDN during preparation, and enough
disk/RAM for headless Chromium. Execution remains network-isolated except local
loopback. Maintain the external rights/branch/build-failure settings above and
verify a browser failure in a separate disposable Dokploy test service before
enabling AutoDeploy; actual production settings were not verified locally.

Chromium desktop headless is the current scope. This is neither a Safari/Firefox/
touch matrix nor an accessibility, visual-baseline, proxy/TLS, performance or load
suite. Detailed grace-period, persistence-error and account-generation cases remain
in the existing backend/React tests instead of being duplicated here.

## Local container verification

This also verifies Docker's actual health status on the final image, with a new
throwaway volume, no published ports, no external network and the production
filesystem restrictions. It never mounts the production volume or reads `.env`.
The smoke source is passed over stdin to Node; it is not installed in the image.

```bash
(
  set -eu
  check_id="pixelfleet-check-$(date +%s)-$$"
  check_image="$check_id:local"
  check_container="$check_id-runtime"
  check_volume="$check_id-data"
  cleanup() {
    docker rm -f "$check_container" >/dev/null 2>&1 || true
    docker volume rm "$check_volume" >/dev/null 2>&1 || true
    docker image rm "$check_image" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  trap 'exit 1' INT TERM
  docker build --progress=plain --target runtime -t "$check_image" .
  docker volume create "$check_volume"
  docker run -d --name "$check_container" --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --mount "type=volume,src=$check_volume,dst=/app/data" \
    --health-interval 1s --health-start-period 1s \
    -e TRUST_PROXY=false "$check_image"
  attempts=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$check_container")" = healthy ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 40 ]; then docker logs "$check_container"; exit 1; fi
    sleep 1
  done
  docker exec "$check_container" node scripts/healthcheck.mjs
  docker exec -i -e SMOKE_BASE_URL=http://127.0.0.1:3001 "$check_container" \
    node --input-type=module < scripts/smoke-match.mjs
  docker stop --time 15 "$check_container"
  test "$(docker inspect -f '{{.State.ExitCode}}' "$check_container")" = 0
)
```

### Reproduce a failing browser gate safely (TD-08)

Run this from the repository root. It copies the current sources (including
uncommitted corrections) into a temporary context, adds one failing test there,
and checks that the default image path fails without exporting its unique tag.
It then deletes the probe and repeats the full successful build without cache.
The original checkout and existing Docker resources are not modified.

```bash
(
  set -eu
  probe_context=$(mktemp -d)
  probe_image="pixelfleet-gate-probe:$(date +%s)-$$"
  cleanup() {
    docker image rm "$probe_image" >/dev/null 2>&1 || true
    rm -rf "$probe_context"
  }
  trap cleanup EXIT
  trap 'exit 1' INT TERM
  tar --exclude=.git --exclude=.agents --exclude=.idea --exclude=node_modules \
    --exclude=dist --exclude=test-results --exclude='.env*' --exclude='*.sqlite*' --exclude='*.tsbuildinfo' \
    -cf - . | tar -xf - -C "$probe_context"
  cat > "$probe_context/tests/browser/gate-probe.browser.ts" <<'TEST'
import { test, expect } from "./fixtures.js";
test("TD-08 deliberately blocks image export", async ({ game }) => {
  const captain = await game.captain("Browser Gate Probe");
  await expect(captain.page.getByRole("button", { name: "Start Game", exact: true }))
    .toHaveText("INTENTIONAL TD-08 FAILURE", { timeout: 1000 });
});
TEST
  if docker build --progress=plain -t "$probe_image" "$probe_context" > "$probe_context/failure.log" 2>&1; then
    echo 'ERROR: failing test did not block the image'; exit 1
  fi
  cat "$probe_context/failure.log"
  grep -q 'TD-08 deliberately blocks image export' "$probe_context/failure.log"
  grep -q '1 failed' "$probe_context/failure.log"
  if docker image inspect "$probe_image" >/dev/null 2>&1; then
    echo 'ERROR: failed gate exported an image'; exit 1
  fi
  rm "$probe_context/tests/browser/gate-probe.browser.ts"
  docker build --no-cache --progress=plain -t "$probe_image" "$probe_context"
)
```

## Dependency maintenance (TD-09)

Use Node 24.15+ within 24.x and `npm ci` against the committed lockfile. Security
updates must include development/build/test dependencies: they run on developer
machines and in the builder even though they are absent from the runtime image.
The TD-09 advisory inventory, primary sources and version decisions are recorded in
[the remediation report](tech-debt-remediation.md#td-09--gezielte-advisory-behandlung).

```bash
npm ci
npm ls --all
# These commands send package/version information to npm's advisory service.
npm audit
npm audit --omit=dev
npm run verify
npm run browser:install   # preparation, never an implicit download during tests
npm run browser:test
# Complete mandatory release gate: source, browser, runtime health and match smoke.
docker build --progress=plain --target runtime -t pixelfleet:local-check .
# After the isolated container verification above, remove your local test tag.
docker image rm pixelfleet:local-check
```

Keep `@playwright/test`, `playwright` and `playwright-core` at the same locked version
and reinstall its matching browser revision when changing that version. TD-09 keeps
1.64.0 / Chromium Headless Shell revision 1248. Do not copy browser-tools into the
runtime or replace `runtime` with a diagnostic target. Source, browser and runtime
gate dependencies remain unchanged. An empty npm audit is a time-bound database
check, not evidence of general vulnerability freedom; npm does not audit Chromium,
Node or Debian OS packages. Recheck advisories when upgrading dependencies.

Vite development and preview now bind to `127.0.0.1`. To deliberately expose either
to your LAN from the repository root:

```bash
npm run dev -w apps/frontend -- --host 0.0.0.0
npm run preview -w apps/frontend -- --host 0.0.0.0
```

Development also requires `npm run dev:backend` separately. Preview needs a previous
production build and does not proxy the API/WebSocket paths. Loopback is exposure
reduction and does not replace the fixes (some attacks can originate in a browser
on the same machine). These flags do not change the production backend binding.
Audit/tree/build evidence for this maintenance run is kept locally in ignored
`test-results/td09/`; existing browser failure artifacts use the TD-08 paths above.
The external Dokploy permissions/target/failure checks remain as documented above;
no deployment or active production block is verified by this local maintenance.

## References

- [Dokploy Docker Compose and environment variables](https://docs.dokploy.com/docs/core/docker-compose)
- [Dokploy Compose domain routing](https://docs.dokploy.com/docs/core/docker-compose/domains)
- [Docker multi-stage build dependencies](https://docs.docker.com/build/building/multi-stage/)
- [Dockerfile bind mounts and network isolation](https://docs.docker.com/reference/dockerfile/#run---mount)
