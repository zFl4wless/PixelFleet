import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@pixelfleet/shared";

let directory: string;
const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-deployment-"));
  await mkdir(join(directory, "frontend"));
  await writeFile(join(directory, "frontend/index.html"), "<!doctype html><title>Deployment fixture</title>");
  await writeFile(join(directory, "frontend/404.html"), "<!doctype html><title>404 - Page not found | Pixel Fleet</title>");
  for (const route of ["legal-notice", "privacy-policy"]) {
    await mkdir(join(directory, "frontend", route));
    await writeFile(join(directory, "frontend", route, "index.html"), `<!doctype html><title>${route}</title>`);
  }
  await mkdir(join(directory, "frontend/assets"));
  await writeFile(join(directory, "frontend/assets/app.js"), "console.log('asset');");
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

function launch(overrides: Record<string, string> = {}, entrypoint = "apps/backend/src/server.ts") {
  const child = spawn(process.execPath, ["--import", "tsx", entrypoint], {
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

async function loginGuest(url: string, username = "Cookie test guest") {
  const response = await fetch(`${url}/api/guest-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ username })
  });
  expect(response.status).toBe(201);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const { profile } = await response.json();
  return { cookie, profile };
}

async function openSessionSocket(url: string, cookie: string) {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
    headers: { Cookie: cookie, Origin: url },
    handshakeTimeout: 2_000
  });
  sockets.push(socket);
  const firstMessage = once(socket, "message");
  // Observe both promises immediately if the handshake unexpectedly fails.
  const [, [data]] = await Promise.all([once(socket, "open"), firstMessage]);
  const message = JSON.parse(data.toString());
  expect(message.type).toBe("profile");
  return { socket, profile: message.profile };
}

async function rejectedUpgrade(url: string, cookie?: string, origin = url): Promise<number> {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
    headers: { Origin: origin, ...(cookie === undefined ? {} : { Cookie: cookie }) },
    handshakeTimeout: 2_000
  });
  sockets.push(socket);
  let connectionHeader: string | undefined;
  let setCookieHeader: string[] | undefined;
  let contentLengthHeader: string | undefined;
  const statusCode = await new Promise<number>((resolve, reject) => {
    let status: number | undefined;
    socket.on("error", (error) => {
      if (status === undefined) {
        reject(error);
      }
    });
    socket.once("open", () => {
      reject(new Error("Rejected authentication unexpectedly opened a WebSocket."));
      socket.terminate();
    });
    socket.once("unexpected-response", (_request, response) => {
      status = response.statusCode;
      connectionHeader = response.headers.connection;
      setCookieHeader = response.headers["set-cookie"];
      contentLengthHeader = response.headers["content-length"];
      response.resume();
      socket.terminate();
    });
    socket.once("close", () => {
      if (status === undefined) {
        reject(new Error("Upgrade closed without a controlled HTTP rejection."));
      } else {
        resolve(status);
      }
    });
  });
  expect(connectionHeader).toBe("close");
  expect(setCookieHeader).toBeUndefined();
  expect(contentLengthHeader).toBe("0");
  return statusCode;
}

describe("production deployment", () => {
  it("reconnects to the new active match while the previous result is still retained", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const player = await loginGuest(url, "Returning match dummy");
    const oldOpponent = await loginGuest(url, "Previous match dummy");
    const newOpponent = await loginGuest(url, "Next match dummy");
    const first = (await openSessionSocket(url, player.cookie)).socket;
    const previous = (await openSessionSocket(url, oldOpponent.cookie)).socket;
    const next = (await openSessionSocket(url, newOpponent.cookie)).socket;
    function waitView(socket: WebSocket, predicate: (message: Extract<ServerMessage, { type: "game_update" | "match_finished" }>) => boolean) {
      return new Promise<Extract<ServerMessage, { type: "game_update" | "match_finished" }>["view"]>((resolve, reject) => {
        const onMessage = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString()) as ServerMessage;
          if ((message.type === "game_update" || message.type === "match_finished") && predicate(message)) {
            cleanup();
            resolve(message.view);
          }
        };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onClose = () => { cleanup(); reject(new Error("Socket closed before the expected match view.")); };
        function cleanup() {
          socket.off("message", onMessage);
          socket.off("error", onError);
          socket.off("close", onClose);
        }
        socket.on("message", onMessage);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
    }
    const matched = waitView(first, (message) => message.view.phase === "placing");
    const queued = once(first, "message");
    first.send(JSON.stringify({ type: "join_queue" }));
    expect(JSON.parse((await queued)[0].toString())).toMatchObject({ type: "queue_status", queued: true });
    previous.send(JSON.stringify({ type: "join_queue" }));
    const oldView = await matched;
    const finished = waitView(first, (message) => message.type === "match_finished");
    first.send(JSON.stringify({ type: "leave_match" }));
    expect(await finished).toMatchObject({ matchId: oldView.matchId, result: { reason: "forfeit" } });
    const newMatch = waitView(first, (message) => message.view.phase === "placing");
    const requeued = once(first, "message");
    first.send(JSON.stringify({ type: "join_queue" }));
    expect(JSON.parse((await requeued)[0].toString())).toMatchObject({ type: "queue_status", queued: true });
    next.send(JSON.stringify({ type: "join_queue" }));
    const newView = await newMatch;
    expect(newView.matchId).not.toBe(oldView.matchId);
    const disconnected = waitView(next, (message) => message.view.opponent.connected === false);
    const closed = once(first, "close");
    first.close();
    expect(await disconnected).toMatchObject({ matchId: newView.matchId, opponent: { connected: false } });
    await closed;
    const current = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Cookie: player.cookie, Origin: url }, handshakeTimeout: 2_000
    });
    sockets.push(current);
    const recovered = waitView(current, (message) => message.view.you.connected);
    const opponentRecovered = waitView(next, (message) => message.view.opponent.connected);
    const [, recoveredView, opponentView] = await Promise.all([once(current, "open"), recovered, opponentRecovered]);
    expect(recoveredView).toMatchObject({ matchId: newView.matchId, phase: "placing" });
    expect(opponentView.reconnectDeadline).toBeUndefined();
    const health = await fetch(`${url}/api/health`);
    expect((await health.json()).hub).toMatchObject({ placingMatches: 1, finishedMatches: 1, queuedPlayers: 0 });
    await stop(child);
  }, 15_000);

  it("revokes logout sockets by session without revoking an independent session of the same account", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const first = await loginGuest(url, "Session-scoped dummy");
    const independentToken = `independent-dummy-${randomUUID()}`;
    const independentCookie = `pf_session=${independentToken}`;
    const fixtureDatabase = new DatabaseSync(join(directory, "pixelfleet.sqlite"));
    try {
      const timestamp = new Date().toISOString();
      fixtureDatabase.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
        .run(createHash("sha256").update(independentToken).digest("hex"), first.profile.userId, timestamp, timestamp);
    } finally {
      fixtureDatabase.close();
    }
    const old = await openSessionSocket(url, first.cookie);
    const replaced = once(old.socket, "close");
    const current = await openSessionSocket(url, independentCookie);
    expect((await replaced)[0]).toBe(4001);
    const other = await loginGuest(url, "Independent account dummy");
    const unaffected = await openSessionSocket(url, other.cookie);
    const oldLogout = await fetch(`${url}/api/logout`, {
      method: "POST", headers: { Origin: url, Cookie: first.cookie }
    });
    expect(oldLogout.status).toBe(200);
    expect(oldLogout.headers.get("set-cookie")).toContain("Max-Age=0");
    await oldLogout.json();
    const oldMe = await fetch(`${url}/api/me`, { headers: { Cookie: first.cookie } });
    expect(oldMe.status).toBe(401);
    await oldMe.json();
    expect(await rejectedUpgrade(url, first.cookie)).toBe(401);
    const currentMe = await fetch(`${url}/api/me`, { headers: { Cookie: independentCookie } });
    expect(currentMe.status).toBe(200);
    expect((await currentMe.json()).profile.userId).toBe(first.profile.userId);
    expect(current.socket.readyState).toBe(WebSocket.OPEN);
    const queued = once(current.socket, "message");
    current.socket.send(JSON.stringify({ type: "join_queue" }));
    expect(JSON.parse((await queued)[0].toString())).toMatchObject({ type: "queue_status", queued: true });
    const closed = once(current.socket, "close");
    const logout = await fetch(`${url}/api/logout`, {
      method: "POST", headers: { Origin: url, Cookie: independentCookie }
    });
    expect(logout.status).toBe(200);
    await logout.json();
    expect((await closed)[0]).toBe(4003);
    expect(await rejectedUpgrade(url, independentCookie)).toBe(401);
    const otherMe = await fetch(`${url}/api/me`, { headers: { Cookie: other.cookie } });
    expect(otherMe.status).toBe(200);
    await otherMe.json();
    expect(unaffected.socket.readyState).toBe(WebSocket.OPEN);
    const health = await fetch(`${url}/api/health`);
    expect((await health.json()).hub).toMatchObject({ activeConnections: 1, queuedPlayers: 0 });
    await stop(child);
  }, 15_000);

  it("invalidates runtime-reset connections while keeping the session available for reconnect", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const player = await loginGuest(url, "Runtime-reset dummy");
    const old = await openSessionSocket(url, player.cookie);
    const queued = once(old.socket, "message");
    old.socket.send(JSON.stringify({ type: "join_queue" }));
    expect(JSON.parse((await queued)[0].toString())).toMatchObject({ type: "queue_status", queued: true });
    const closed = once(old.socket, "close");
    const reset = await fetch(`${url}/api/admin/reset`, {
      method: "POST",
      headers: { Origin: url, Authorization: "Bearer deployment-test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "runtime" })
    });
    expect(reset.status).toBe(200);
    expect((await reset.json()).hub).toMatchObject({ activeConnections: 0, queuedPlayers: 0, matches: 0 });
    expect((await closed)[0]).toBe(4009);
    const current = await openSessionSocket(url, player.cookie);
    expect(current.profile.userId).toBe(player.profile.userId);
    const requeued = once(current.socket, "message");
    current.socket.send(JSON.stringify({ type: "join_queue" }));
    expect(JSON.parse((await requeued)[0].toString())).toMatchObject({ type: "queue_status", queued: true });
    const health = await fetch(`${url}/api/health`);
    expect((await health.json()).hub).toMatchObject({ activeConnections: 1, queuedPlayers: 1, matches: 0 });
    await stop(child);
  }, 15_000);

  it("rejects malformed cookies without creating accounts or changing an existing HTTP session", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const { cookie, profile } = await loginGuest(url);
    for (const invalid of ["pf_session=%", "pf_session=%GG", "pf_session=%C3", `${cookie}; preference=%`]) {
      for (const [path, method] of [["/api/me", "GET"], ["/api/guest-login", "POST"], ["/api/logout", "POST"]]) {
        const response = await fetch(url + path, {
          method,
          headers: { Cookie: invalid, Origin: url, "Content-Type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ username: "Unused dummy guest" }) } : {})
        });
        expect(response.status).toBe(400);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect((await response.json()).error).toBe("Invalid cookie encoding.");
      }
    }
    const me = await fetch(`${url}/api/me`, { headers: { Cookie: `theme=dark; ${cookie}` } });
    expect(me.status).toBe(200);
    expect((await me.json()).profile.userId).toBe(profile.userId);
    const existingLogin = await fetch(`${url}/api/guest-login`, {
      method: "POST", headers: { Cookie: cookie, Origin: url }
    });
    expect(existingLogin.status).toBe(200);
    expect((await existingLogin.json()).profile.userId).toBe(profile.userId);
    const status = await fetch(`${url}/api/admin/status`, {
      headers: { Authorization: "Bearer deployment-test-token" }
    });
    expect(status.status).toBe(200);
    expect((await status.json()).database).toMatchObject({ users: 1, sessions: 1 });
    await stop(child);
  }, 15_000);

  it("controls upgrade rejection and preserves valid authentication and active connection limits", async () => {
    const { child, ready } = launch({ MAX_WS_PER_IP: "1" });
    const url = await ready;
    const { cookie, profile } = await loginGuest(url);
    for (const invalid of ["pf_session=%", "pf_session=%GG", "pf_session=%C3", `${cookie}; preference=%`]) {
      expect(await rejectedUpgrade(url, invalid)).toBe(400);
    }
    expect(await rejectedUpgrade(url)).toBe(401);
    expect(await rejectedUpgrade(url, "pf_session=unknown-dummy-token")).toBe(401);
    expect(await rejectedUpgrade(url, cookie, "https://untrusted.example")).toBe(403);
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).hub).toMatchObject({ activeConnections: 0, queuedPlayers: 0, matches: 0 });
    const token = cookie.slice("pf_session=".length);
    const encodedCookie = `pf_session=%${token.charCodeAt(0).toString(16)}${token.slice(1)}`;
    const opened = await openSessionSocket(url, `theme=dark; ${encodedCookie}`);
    expect(opened.profile.userId).toBe(profile.userId);
    expect(await rejectedUpgrade(url, cookie)).toBe(429);
    const closed = once(opened.socket, "close");
    opened.socket.close();
    await closed;
    await expect.poll(async () => (await (await fetch(`${url}/api/health`)).json()).hub.activeConnections).toBe(0);
    const reconnected = await openSessionSocket(url, cookie);
    expect(reconnected.profile.userId).toBe(profile.userId);
    await stop(child);
  }, 15_000);

  it("returns a controlled upgrade error on session storage failure and recovers without a leaked slot", async () => {
    const { child, ready } = launch({ MAX_WS_PER_IP: "1" });
    const url = await ready;
    const { cookie, profile } = await loginGuest(url);
    const fixtureDatabase = new DatabaseSync(join(directory, "pixelfleet.sqlite"));
    try {
      fixtureDatabase.exec("ALTER TABLE sessions RENAME TO sessions_fixture_backup");
      try {
        expect(await rejectedUpgrade(url, cookie)).toBe(500);
        const health = await fetch(`${url}/api/health`);
        expect(health.status).toBe(200);
        expect((await health.json()).hub.activeConnections).toBe(0);
      } finally {
        fixtureDatabase.exec("ALTER TABLE sessions_fixture_backup RENAME TO sessions");
      }
    } finally {
      fixtureDatabase.close();
    }
    const me = await fetch(`${url}/api/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).profile.userId).toBe(profile.userId);
    expect((await openSessionSocket(url, cookie)).profile.userId).toBe(profile.userId);
    await stop(child);
  }, 15_000);

  it("cleans up failed initialization after the handshake without releasing another connection's slot", async () => {
    // Fault injection is confined to this disposable test entrypoint, with no application test hook.
    const entrypoint = join(directory, "initialization-fault.mjs");
    const hubUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/game-hub.ts")).href;
    const serverUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/server.ts")).href;
    await writeFile(entrypoint, `
      const { GameHub } = await import(${JSON.stringify(hubUrl)});
      const originalConnect = GameHub.prototype.connect;
      let connections = 0;
      GameHub.prototype.connect = function (ws, ...args) {
        connections += 1;
        if (connections !== 2) return originalConnect.call(this, ws, ...args);
        const originalSend = ws.send;
        ws.send = () => { throw new Error("Dummy initialization failure"); };
        try { return originalConnect.call(this, ws, ...args); }
        finally { ws.send = originalSend; }
      };
      await import(${JSON.stringify(serverUrl)});
    `);
    const { child, ready } = launch({ MAX_WS_PER_IP: "2" }, entrypoint);
    const url = await ready;
    const first = await loginGuest(url, "First dummy guest");
    const second = await loginGuest(url, "Second dummy guest");
    const stable = await openSessionSocket(url, first.cookie);
    const failed = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
      headers: { Cookie: second.cookie, Origin: url }, handshakeTimeout: 2_000
    });
    sockets.push(failed);
    const messages: string[] = [];
    failed.on("message", (data) => messages.push(data.toString()));
    // Termination can arrive before the client observes the already-written handshake.
    failed.on("error", () => {});
    const closed = new Promise<[number]>((resolve) => failed.once("close", (code) => resolve([code])));
    expect((await closed)[0]).toBe(1006);
    expect(messages).toEqual([]);
    await expect.poll(async () => (await (await fetch(`${url}/api/health`)).json()).hub.activeConnections).toBe(1);
    expect(stable.socket.readyState).toBe(WebSocket.OPEN);
    const recovered = await openSessionSocket(url, second.cookie);
    expect(recovered.profile.userId).toBe(second.profile.userId);
    expect(await rejectedUpgrade(url, first.cookie)).toBe(429);
    await stop(child);
  }, 15_000);

  it("keeps failed upgrade attempts charged to the attempt limit", async () => {
    const { child, ready } = launch({ MAX_WS_PER_IP: "1", WS_CONNECTS_PER_MINUTE: "2" });
    const url = await ready;
    const { cookie } = await loginGuest(url);
    expect(await rejectedUpgrade(url, "pf_session=%")).toBe(400);
    const { socket } = await openSessionSocket(url, cookie);
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await expect.poll(async () => (await (await fetch(`${url}/api/health`)).json()).hub.activeConnections).toBe(0);
    expect(await rejectedUpgrade(url, cookie)).toBe(429);
    await stop(child);
  }, 15_000);

  it("serves a real 404 HTML page for unknown routes on GET and HEAD", async () => {
    const { child, ready } = launch();
    const url = await ready;
    for (const path of ["/xxx", "/xxx/", "/legal-notice/unknown", "/apiculture", "/404.html"]) {
      const response = await fetch(url + path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(await response.text()).toContain("404 - Page not found");
    }
    const head = await fetch(`${url}/xxx`, { method: "HEAD" });
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
    await stop(child);
  }, 15_000);

  it("keeps known pages and assets available while missing assets and APIs return 404", async () => {
    const { child, ready } = launch();
    const url = await ready;
    for (const path of ["/", "/index.html", "/legal-notice", "/legal-notice/", "/legal-notice/index.html", "/privacy-policy", "/privacy-policy/", "/%6Cegal-notice/"]) {
      const response = await fetch(url + path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      if (path.includes("legal") || path.includes("privacy") || path.includes("%6C")) {
        expect(response.headers.get("x-robots-tag")).toContain("noindex");
      }
      await response.text();
    }
    const asset = await fetch(`${url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toContain("console.log");
    for (const path of ["/assets/missing.js", "/missing.svg", "/api/unknown", "/ws/unknown"]) {
      const response = await fetch(url + path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect((await response.json()).error).toBe("Route not found.");
    }
    await stop(child);
  }, 15_000);

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
