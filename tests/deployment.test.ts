import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

let directory: string;
const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-deployment-"));
  await mkdir(join(directory, "frontend"));
  await writeFile(join(directory, "frontend/index.html"), "<!doctype html><title>Deployment fixture</title>");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  await rm(directory, { recursive: true, force: true });
});

function launch(overrides: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
      DATABASE_PATH: join(directory, "pixelfleet.sqlite"),
      FRONTEND_DIST_DIR: join(directory, "frontend"),
      FRONTEND_ORIGIN: "",
      ADMIN_TOKEN: "deployment-test-token",
      TRUST_PROXY: "true",
      ...overrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  let output = "";
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout!.on("data", (data) => {
      output += data;
      const port = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
      if (port) {
        resolve(`http://127.0.0.1:${port}`);
      }
    });
    child.stderr!.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Server exited with ${code}: ${output}`)));
  });
  return { child, ready };
}

async function stop(child: ChildProcess) {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code, signal] = await exited;
  expect(signal).toBeNull();
  expect(code).toBe(0);
}

describe("production deployment", () => {
  it("keeps health probes available after the visitor rate limit is exhausted", async () => {
    const { child, ready } = launch({ HTTP_REQUESTS_PER_MINUTE: "1" });
    const url = await ready;
    const frontend = await fetch(url);
    expect(await frontend.text()).toContain("Deployment fixture");
    const blocked = await fetch(url);
    expect(blocked.status).toBe(429);
    await blocked.text();
    for (let probe = 0; probe < 3; probe += 1) {
      const health = await fetch(`${url}/api/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).ok).toBe(true);
    }
    await stop(child);
  }, 15_000);

  it("preserves sessions through shutdown and closes WebSockets with restart status", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const login = await fetch(`${url}/api/guest-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https", Origin: url },
      body: JSON.stringify({ username: "Deployment guest" })
    });
    expect(login.status).toBe(201);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("; Secure");
    const { profile } = await login.json();

    const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Cookie: cookie.split(";")[0], Origin: url }
    });
    sockets.push(socket);
    await once(socket, "open");
    const opponentLogin = await fetch(`${url}/api/guest-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ username: "Deployment opponent" })
    });
    expect(opponentLogin.status).toBe(201);
    const opponentCookie = opponentLogin.headers.get("set-cookie")!.split(";")[0];
    await opponentLogin.json();
    const opponent = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Cookie: opponentCookie, Origin: url }
    });
    sockets.push(opponent);
    await once(opponent, "open");
    const matched = new Promise<void>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "game_update" && message.view.phase === "placing") {
          resolve();
        }
      });
    });
    socket.send(JSON.stringify({ type: "join_queue" }));
    opponent.send(JSON.stringify({ type: "join_queue" }));
    await matched;
    const closed = once(socket, "close");
    const opponentClosed = once(opponent, "close");
    await stop(child);
    const [code] = await closed;
    expect(code).toBe(1012);
    expect((await opponentClosed)[0]).toBe(1012);

    const restarted = launch();
    const restartedUrl = await restarted.ready;
    const me = await fetch(`${restartedUrl}/api/me`, { headers: { Cookie: cookie.split(";")[0] } });
    expect(me.status).toBe(200);
    const persisted = (await me.json()).profile;
    expect(persisted.userId).toBe(profile.userId);
    expect(persisted.stats.gamesPlayed).toBe(0);
    await stop(restarted.child);
  }, 15_000);

  it("rejects foreign origins and protects admin endpoints behind the proxy", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const rejected = await fetch(`${url}/api/guest-login`, {
      method: "POST",
      headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Foreign guest" })
    });
    expect(rejected.status).toBe(403);
    await rejected.text();
    const unauthorized = await fetch(`${url}/api/admin/status`);
    expect(unauthorized.status).toBe(401);
    await unauthorized.text();
    const authorized = await fetch(`${url}/api/admin/status`, {
      headers: { Authorization: "Bearer deployment-test-token" }
    });
    expect(authorized.status).toBe(200);
    expect((await authorized.json()).ok).toBe(true);
    await stop(child);
  }, 15_000);

  it("fails startup when the production frontend is absent", async () => {
    const { ready } = launch({ FRONTEND_DIST_DIR: join(directory, "missing") });
    await expect(ready).rejects.toThrow(/ENOENT[\s\S]*missing[\s\S]*index\.html/);
  }, 15_000);
});
