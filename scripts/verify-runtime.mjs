import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Used only during image verification; never included in the runtime image.
const directory = await mkdtemp(join(tmpdir(), "pixelfleet-release-"));
const abort = new AbortController();
const interrupted = () => abort.abort(new Error("Runtime verification interrupted"));
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);

function start(args, env, timeout) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; process.stdout.write(data); });
  child.stderr.on("data", (data) => { output += data; process.stderr.write(data); });
  const kill = () => child.kill("SIGKILL");
  abort.signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, timeout);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", kill);
  });
  return { child, exited, output: () => output };
}

async function run(args, env = {}) {
  abort.signal.throwIfAborted();
  const task = start(args, env, 60_000);
  assert.deepEqual(await task.exited, { code: 0, signal: null }, `${args.join(" ")} failed: ${task.output()}`);
}

let backend;
try {
  abort.signal.throwIfAborted();
  backend = start(["apps/backend/dist/server.js"], {
    NODE_ENV: "production",
    PORT: "0",
    DATABASE_PATH: join(directory, "fixture.sqlite"),
    TRUST_PROXY: "false",
    FRONTEND_ORIGIN: "",
    ADMIN_TOKEN: ""
  }, 90_000);
  const ready = new Promise((resolve, reject) => {
    backend.child.stdout.on("data", () => {
      const port = backend.output().match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
      if (port) resolve(port);
    });
    backend.exited.then((status) => reject(new Error(`Backend exited before readiness: ${JSON.stringify(status)}`)), reject);
  });
  const port = await ready;
  await run(["scripts/healthcheck.mjs"], { PORT: port });
  console.log("Runtime healthcheck passed");
  await run([fileURLToPath(new URL("./smoke-match.mjs", import.meta.url))], {
    SMOKE_BASE_URL: `http://127.0.0.1:${port}`
  });
  await run(["scripts/healthcheck.mjs"], { PORT: port });
  backend.child.kill("SIGTERM");
  assert.deepEqual(await backend.exited, { code: 0, signal: null }, "Backend shutdown failed");
  console.log("Runtime match smoke and graceful shutdown passed");
} finally {
  abort.abort();
  // Wait for owned processes before deleting their SQLite fixture (also on failure).
  if (backend) await backend.exited.catch(() => {});
  await rm(directory, { recursive: true, force: true });
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
}
