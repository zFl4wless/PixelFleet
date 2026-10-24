# Node.js security update: 24.22.1

Prepared on 2026-10-24. This runbook describes operator actions after review and
approval. No production access, push or deployment is part of this repository change.

## Scope and build provenance

- Both external Docker bases (`manifests` and `runtime-base`) use
  `node:24.22.1-bookworm-slim`. All nine stages inherit Node 24.22.1, including
  build tools, production dependencies, browser checks and the final `runtime`.
- Debian Bookworm Slim, npm workspaces, dependency versions and lockfile resolution
  remain unchanged. The root manifest and lockfile require Node `>=24.22.1`.
- Production Compose remains `docker-compose.yml`, service `pixelfleet`, context
  `.`, Dockerfile `Dockerfile`, target `runtime`. Build arguments remain public
  `VITE_LEGAL_*` values only; `ADMIN_TOKEN` remains a runtime setting.
- Non-root UID/GID 1000, healthcheck, command, read-only root filesystem, capabilities,
  proxy settings, single-instance topology and persistent volume are unchanged.
- Reference base digest supplied by the operator and confirmed by a local pull:
  `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`.
  Explicitly inspect the AMD64 variant on a multi-platform local machine.
- The version tag is pinned, not the digest. Tags can be republished; record the
  resolved digest in deployment evidence. npm uses `npm ci`; Debian packages,
  Playwright downloads and the Dockerfile frontend still use upstream repositories.
  This provides a repeatable version selection, not bit-identical builds.

Node.js identifies 24.22.1 as the security release from 2026-10-21:
[official release notes](https://nodejs.org/en/blog/release/v24.22.1).
Historical Node 24.21.0 observations in the tech-debt reports describe earlier
tests and have deliberately not been rewritten.

## Local validation

The checked-in final target requires `npm run verify` (Vitest, TypeScript, production
build), Playwright Chromium and the production-user runtime health/match/shutdown
check. Test execution uses `--network=none` and temporary SQLite fixtures. Only
dependency/browser preparation uses external downloads. No production `.env`, data
volume or endpoint is needed.

Reproduce on a local Docker Desktop installation; use an isolated Compose project
and explicitly select the production CPU architecture:

```bash
docker compose --env-file /dev/null -f docker-compose.yml \
  -p pixelfleet-node-security-20261024 config --quiet
docker build --check --platform linux/amd64 --target runtime .
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose --env-file /dev/null \
  -f docker-compose.yml -p pixelfleet-node-security-20261024 --progress plain \
  build --pull --no-cache pixelfleet
docker run --rm --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --user node \
  pixelfleet-node-security-20261024-pixelfleet node -p \
  'JSON.stringify({version:process.version,arch:process.arch,uid:process.getuid()})'
```

These commands build and inspect an image without deploying a service. Do not run
`compose up` for this local project against production data. The empty environment file intentionally leaves public
legal details empty; Dokploy must continue supplying its existing public build
arguments for the real deployment. No lint script/configuration or CI workflow is
present; the mandatory release gate resides in the Dockerfile.

Validated locally on 2026-10-24 with Docker Engine 29.9.2 / Compose 5.6.1,
Docker Desktop on ARM64, explicitly building/running Linux AMD64 under emulation:

| Check | Result |
| --- | --- |
| Base pull and isolated execution | Expected digest above; `v24.22.1`, `linux/amd64`, Node architecture `x64` |
| Compose config and Dockerfile `--check` | Passed, no Dockerfile warnings; target and hardening verified |
| Compose production build | `build --pull --no-cache pixelfleet` completed; final target `runtime` exported |
| Vitest | 13 files, 233 tests passed inside `npm run verify` |
| TypeScript and production assets | `npm run typecheck` and all three workspace builds passed |
| Chromium | All 5 existing scenarios passed, no retries |
| Runtime build gate | Health, full match and graceful shutdown passed as production user |
| Exported final image | `v24.22.1`, `x64`, UID 1000; Debian 12 Bookworm |
| Additional final-image smoke | Separate container, network `none`, read-only root, no capabilities, `no-new-privileges`; only RAM-backed test data; Docker health `healthy`, explicit healthchecks passed, full match awarded 350/465 XP, shutdown exit 0 |
| Production filesystem | Only `@pixelfleet` and `ws` project dependencies; no dev/test dependencies, browser, smoke/verification source or gate markers |
| Rollback override | Compose resolves the retained-image reference while preserving the original data mount and hardening; no deployment executed |
| Dependency/diff integrity | Only root `engines.node` changed in the manifest/lockfile; dependency resolution unchanged; `git diff --check` passed |
| Lint / separate CI | Not available: no lint script/configuration or CI workflows exist |
| Live Dokploy/proxy checks | Not executed: production access/deployment is excluded from this task |

Local image tag: `pixelfleet-node-security-20261024-pixelfleet:latest`.
Docker reports the running container's image reference as
`sha256:bb74ec7df483d84b803dcae22223dff546a37b51ac37306d2476f8b6609e738e`;
the AMD64 image manifest is
`sha256:42c9e3a4b0ac1344294155a85290dd4c0ccff0b4480546c8087836cdfeb8db69`.
These are application-image identifiers, distinct from the Node base digest.
The additional test container was stopped successfully; no persistent volume was
created or mounted. The local host's older Node installation was not used for these
tests. Production still requires the operator checks below with its real public
build arguments and effective Dokploy/Traefik configuration.

## Deployment after approval

1. Review `git diff` on `fix/node-security-update`, commit the changes (suggested
   subject: `fix: updates node runtime to 24.22.1`), and merge/push through the usual
   reviewed deployment branch. Check whether an existing webhook/AutoDeploy would
   immediately deploy a push; temporarily disable it in Dokploy before pushing if
   a separate manual release approval is required. Confirm the selected Git revision
   in Dokploy. This task does not push or enable AutoDeploy.
2. Record the actual currently deployed Git revision, Dokploy's complete Compose
   command prefix (project name, every `-f` override and any `--env-file` flag), and
   current application image ID. Preserve domain/proxy overrides and the existing
   project identity. The old image reported for this deployment is:
   `sha256:1d00e3eaf248b598325a7f20eca363ba4e130effd67946ae85134b0dc671b13b`.
   Before replacement, confirm it still matches the running container and retain a
   local tag, so a rebuild is unnecessary during rollback:

   ```bash
   docker image inspect --format '{{.Id}} {{.Architecture}}' \
     sha256:1d00e3eaf248b598325a7f20eca363ba4e130effd67946ae85134b0dc671b13b
   docker image tag \
     sha256:1d00e3eaf248b598325a7f20eca363ba4e130effd67946ae85134b0dc671b13b \
     pixelfleet-rollback:before-node-24.22.1
   ```

   Keep this image available under the server's image-retention policy. Compare the
   selected revision with the actual deployed revision to confirm no unrelated
   application/schema changes are bundled. This Node-only diff changes no schema
   or application code and requires no database migration or restore. Keep the
   established consistent backup policy. Schedule a brief
   interruption: the sole instance restarts and active matches end.
3. Keep Dokploy in **Docker Compose / Compose** mode, using the existing repository,
   `./docker-compose.yml`, root context and target `runtime`. Keep all current
   environment values, domains, port 3001, volume and project name. The VPS remains
   Debian 13; Bookworm is the container userspace and is intentionally unchanged.
4. Trigger a build of the selected new revision with base refresh. If the installed
   Dokploy version exposes a separate build action/hook, use the equivalent of:

   ```bash
   docker compose -p YOUR_EXISTING_PROJECT -f YOUR_ACTUAL_COMPOSE_PATH \
     build --pull pixelfleet
   ```

   Use the recorded complete prefix, including Dokploy's additional Compose files.
   If no separate build action is available, a concrete UI-only alternative is to
   temporarily set **Advanced / Command** to that same `compose ... build --pull
   pixelfleet` command, without the leading `docker`, then trigger Deploy for the new
   revision. Dokploy prepends `docker`; this command replaces its entire default.
   This first action **only builds** and does not update the running container.
   Restore the recorded normal command before the actual deployment in step 5.
   Add `--no-cache` to the build command if a fully fresh gate run is needed; it does
   not replace `--pull`. Do not put shell chaining in Dokploy's Command field.
5. Inspect the build logs: resolved base `node:24.22.1-bookworm-slim`, expected digest
   above (investigate any difference), successful source/TypeScript/build, browser
   and runtime gates, and final `runtime` export. Stop on failure. Restore Dokploy's
   normal build-before-replace command and trigger Deploy for **the same revision**.
   Its usual equivalent is `compose ... up -d --build --remove-orphans`; retain the
   exact existing prefix/flags. Cached successful checks from step 4 are valid for
   identical inputs. `compose pull` or `up --pull always` pulls service images and
   does not replace the base-image refresh in `compose build --pull`.
6. In Dokploy's console for the new `pixelfleet` container, run:

   ```bash
   node --version
   node -e "if (process.version !== 'v24.22.1') process.exit(1); console.log(process.version)"
   node scripts/healthcheck.mjs
   ```

   Expect `v24.22.1` and exit code 0. From the deployment directory the equivalent
   is `docker compose` with the recorded project/files, followed by
   `exec -T pixelfleet node --version` or `exec -T pixelfleet node scripts/healthcheck.mjs`.
   Also record the new container's `.Image` and Docker health state, using only
   selected fields (a full inspect can expose environment secrets):

   ```bash
   docker inspect --format '{{.Image}} {{.State.Health.Status}}' YOUR_NEW_CONTAINER_ID
   ```

   Verify it is the newly built image, differs from the old image ID, and becomes
   **healthy**. Allow the configured 30-second health interval and 10-second start
   period. Review startup/errors in Dokploy without copying secrets into reports.
7. Verify read-only public routes from your own machine: HTTPS `/` loads, assets
   load, and `curl --fail --silent --show-error https://YOUR_DOMAIN/api/health`
   returns the successful health response. Check an existing browser session if
   appropriate. Do not run the match smoke or administrative reset commands against
   production: those create/change data. Perform new-match tests only in a separate
   authorized staging deployment with its own volume. Retain build revision,
   digest, image ID, runtime version and health evidence.

The deployment UI's success state alone is insufficient, especially after the
build-only action. Completion requires verification of the running container.

## Rollback after an unsuccessful deployment

Disable pending automatic deploys and keep the existing Compose project, overrides,
networks, domain configuration and `pixelfleet-data` volume. If only the build failed,
confirm the old container is still serving; no replacement or rollback is needed.

If the new container was replaced and is unhealthy, use the retained **old image**.
Rebuilding an old commit with the formerly floating Node tag does not reproduce the
old image. In the actual deployment directory, create a temporary final Compose
override `node-rollback.override.yml`:

```yaml
services:
  pixelfleet:
    image: pixelfleet-rollback:before-node-24.22.1
```

Use the recorded complete Compose prefix and append this file **last**. In
Dokploy's Command field, run the equivalent below without the leading `docker`,
preserving all actual project/path flags; ensure the override exists in the
deployment checkout used by that action:

```bash
docker compose -p YOUR_EXISTING_PROJECT -f YOUR_ACTUAL_COMPOSE_PATH \
  -f node-rollback.override.yml \
  up -d --no-build --pull never --force-recreate pixelfleet
```

This explicitly selects the retained image without rebuilding or pulling it.
The existing checked-in `build` remains present but `--no-build` skips it for this
emergency operation. Verify the running container's `.Image` equals the old ID,
health is healthy, and HTTPS/health are reachable. Node is expected to be the old
`v24.21.0`, so this temporarily reintroduces the patched vulnerabilities. Prefer a
prompt forward fix. No volume deletion, database restore, schema change, `down`,
pruning or cleanup command is part of this rollback.

Keep AutoDeploy disabled until the next reviewed release. Before that release,
restore the normal build command, remove the temporary override from its input,
select the intended revision and repeat the full security build and checks.

## Future updates

No `.github` workflows, Dependabot configuration or Renovate configuration exists
in this repository. External bot installations/settings have not been inspected.
Dependabot's Docker ecosystem or [Renovate's Dockerfile manager](https://docs.renovatebot.com/modules/manager/dockerfile/) can track these
literal `FROM` references. Reviewed update PRs restricted to Node 24 and the
Bookworm Slim variant would reduce missed patch releases; update the minimum Node
version/documentation together and run the existing complete image gate. There is
no automatic patch movement after this pin. No additional automation is introduced
as part of this targeted update.

References: [Dokploy Compose commands](https://docs.dokploy.com/docs/core/docker-compose),
[Docker base refresh and caching](https://docs.docker.com/build/building/best-practices/),
[Dependabot Docker support](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#package-ecosystem).
