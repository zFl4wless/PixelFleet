import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WS_PROTOCOL, type ServerMessage } from "@pixelfleet/shared";

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

function launch(overrides: Record<string, string> = {}, entrypoint = "apps/backend/src/server.ts", ipc = false) {
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
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"]
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
  return { child, ready, output: () => output };
}

// Deliberately bypass ws's sender validation to exercise the server's receiver.
function writeFrame(socket: WebSocket, frame: Buffer) {
  (socket as unknown as { _socket: import("node:net").Socket })._socket.write(frame);
}

function oversizedFrameHeader(length: number, opcode = 0x81): Buffer {
  const header = Buffer.alloc(8);
  header[0] = opcode;
  header[1] = 0xfe; // Masked frame with a 16-bit payload length.
  header.writeUInt16BE(length, 2);
  return header;
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

async function openSessionSocket(url: string, cookie: string, origin = url, headers: Record<string, string> = {}) {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, WS_PROTOCOL, {
    headers: { ...headers, Cookie: cookie, Origin: origin },
    handshakeTimeout: 2_000
  });
  sockets.push(socket);
  const firstMessage = once(socket, "message");
  // Observe both promises immediately if the handshake unexpectedly fails.
  const [, [data]] = await Promise.all([once(socket, "open"), firstMessage]);
  const message = JSON.parse(data.toString());
  expect(message.type).toBe("session_snapshot");
  return { socket, profile: message.profile, snapshot: message };
}

async function rejectedUpgrade(url: string, cookie?: string, origin = url, headers: Record<string, string> = {}): Promise<number> {
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, WS_PROTOCOL, {
    headers: { ...headers, Origin: origin, ...(cookie === undefined ? {} : { Cookie: cookie }) },
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
  it("asks legacy clients to reload and releases their transport slot before accepting the snapshot protocol (TD-06)", async () => {
    const { child, ready } = launch({ MAX_WS_PER_IP: "1" }); const url = await ready;
    const player = await loginGuest(url);
    const legacy = new WebSocket(`${url.replace("http:", "ws:")}/ws`, { headers: { Cookie: player.cookie, Origin: url } });
    sockets.push(legacy);
    const first = once(legacy, "message"); const closed = once(legacy, "close");
    expect(JSON.parse((await first)[0].toString())).toMatchObject({ type: "toast", message: expect.stringContaining("Reload this page") });
    expect((await closed)[0]).toBe(4002);
    expect((await (await fetch(`${url}/api/health`)).json()).hub.activeConnections).toBe(0);
    const current = await openSessionSocket(url, player.cookie);
    expect(current.socket.protocol).toBe(WS_PROTOCOL);
    expect(current.snapshot).toMatchObject({ type: "session_snapshot", profile: player.profile, state: { kind: "lobby" } });
    await stop(child);
  }, 15_000);

  it("contains preparation, async static and post-header failures without duplicate responses (TD-07)", async () => {
    const entrypoint = join(directory, "http-faults.mjs");
    const serverUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/server.ts")).href;
    await writeFile(join(directory, "frontend/assets/open-failure.js"), "fixture");
    await writeFile(join(directory, "frontend/assets/read-failure.js"), "fixture");
    await writeFile(entrypoint, `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import { ServerResponse, IncomingMessage } from 'node:http';
      import { Readable } from 'node:stream';
      const require = createRequire(import.meta.url);
      const fs = require('node:fs/promises');
      const stat = fs.stat, open = fs.open;
      const secret = 'secret-internal-message /private/secret-file SELECT private_sql';
      fs.stat = async function(path, ...args) {
        if (String(path).endsWith('syntax-failure.js')) throw new SyntaxError(secret);
        if (String(path).endsWith('unknown-failure.js')) throw { secret };
        return stat.call(this, path, ...args);
      };
      fs.open = async function(path, ...args) {
        if (String(path).endsWith('open-failure.js')) throw Object.assign(new Error(secret), { code: 'EACCES' });
        const handle = await open.call(this, path, ...args);
        if (String(path).endsWith('read-failure.js')) handle.createReadStream = () => new Readable({ read() {
          if (this.sent) return; this.sent = true; this.push('partial response');
          setImmediate(() => this.destroy(new Error(secret)));
        } });
        return handle;
      };
      syncBuiltinESMExports();
      let lateWrites = 0;
      for (const method of ['setHeader', 'writeHead', 'end']) {
        const original = ServerResponse.prototype[method];
        ServerResponse.prototype[method] = function(...args) {
          if (this.destroyed || this.writableEnded || (method !== 'end' && this.headersSent)) lateWrites++;
          if (method === 'setHeader' && args[0] === 'Content-Security-Policy' && this.req.url.startsWith('/prep-failure')) throw new TypeError(secret);
          return original.apply(this, args);
        };
      }
      const emit = IncomingMessage.prototype.emit;
      IncomingMessage.prototype.emit = function(event, ...args) {
        if (event === 'data' && this.url === '/api/guest-login?abort-fixture') process.send({ bodyStarted: true });
        return emit.call(this, event, ...args);
      };
      process.on('message', () => process.send({ lateWrites }));
      await import(${JSON.stringify(serverUrl)});
    `);
    const { child, ready, output } = launch({}, entrypoint, true);
    const url = await ready;
    const ids: string[] = [];
    for (const path of ["/prep-failure?secret-query=x", "/assets/syntax-failure.js", "/assets/unknown-failure.js", "/assets/open-failure.js"]) {
      const response = await fetch(`${url}${path}`, { headers: { Cookie: "secret-cookie", Authorization: "Bearer secret-authorization", "X-Admin-Token": "secret-admin" } });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "Internal server error.", requestId: response.headers.get("x-request-id") });
      ids.push(body.requestId);
    }
    // Once headers/body have started, close the stream rather than writing a JSON 500.
    const partial = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(`${url}/assets/read-failure.js`, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
        res.once("aborted", () => resolve({ status: res.statusCode!, text }));
        res.once("end", () => reject(new Error("Faulty read unexpectedly completed")));
        res.on("error", () => {});
      });
      req.on("error", reject); req.end();
    });
    expect(partial).toEqual({ status: 200, text: "partial response" });
    // A client disconnect during async input must not create an account or write later.
    const started = once(child, "message");
    const aborted = request(`${url}/api/guest-login?abort-fixture`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url } });
    aborted.on("error", () => {}); aborted.write('{"username":"secret-aborted-body');
    expect((await started)[0]).toEqual({ bodyStarted: true }); aborted.destroy();
    expect((await fetch(`${url}/api/health`)).status).toBe(200);
    const snapshot = await (await fetch(`${url}/api/admin/metrics`, { headers: { Authorization: "Bearer deployment-test-token" } })).json();
    expect(snapshot.counters).toMatchObject({ http_errors_total: 4, http_client_errors_total: 0, http_server_errors_total: 4, guest_accounts_created_total: 0 });
    for (const [index, kind] of ["type", "syntax", "unknown", "error"].entries()) {
      expect(snapshot.recentEvents.find((event: { requestId: string }) => event.requestId === ids[index])).toMatchObject({
        type: "error", stage: index === 0 ? "preparation" : "static", diagnostic: { kind }
      });
    }
    expect(snapshot.recentEvents.some((event: { responseState: string }) => event.responseState === "closed")).toBe(true);
    expect(snapshot.recentEvents).toHaveLength(6);
    const serialized = JSON.stringify(snapshot.recentEvents) + output();
    for (const secret of ["secret-internal-message", "/private/secret-file", "private_sql", "secret-query", "secret-cookie", "secret-authorization", "secret-admin", "secret-aborted-body", directory]) expect(serialized).not.toContain(secret);
    const observed = once(child, "message"); child.send("snapshot");
    expect((await observed)[0]).toEqual({ lateWrites: 0 });
    await loginGuest(url, "Recovered process");
    await stop(child);
  }, 15_000);

  it("validates JSON structure, field types, media type and exact/chunked body limits without input leaks (TD-07)", async () => {
    const { child, ready } = launch({ GUEST_LOGINS_PER_HOUR: "100" });
    const url = await ready;
    const responses: string[] = [];
    let errors = 0;
    async function invalid(body: string | Buffer, status: number, extra: Record<string, string> = {}, path = "/api/guest-login") {
      const response = await fetch(`${url}${path}`, { method: "POST", headers: { Origin: url, "Content-Type": "application/json", ...extra }, body });
      expect(response.status).toBe(status);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      responses.push(await response.text());
      errors++;
    }
    for (const body of [
      '{"secret-body":', "", "null", "[]", '"secret-body"', "42", "true",
      '{"username":null}', '{"username":42}', '{"username":[]}', '{"username":{}}', '{"username":true}',
      '{}', '{"username":"a"}', '{"username":"admin"}'
    ]) await invalid(body, 400);
    for (const body of ["null", "[]", '"secret-reset-body"', '{"scope":null}', '{"scope":42}', '{"scope":[]}', '{"scope":{}}', '{"scope":"secret-reset-scope"}']) {
      await invalid(body, 400, { Authorization: "Bearer deployment-test-token" }, "/api/admin/reset");
    }
    for (const type of ["text/plain", "application/jsonp", "text/application/json", "application/problem+json"]) {
      await invalid('{"username":"secret-body"}', 415, { "Content-Type": type });
    }
    const missingType = await fetch(`${url}/api/guest-login`, { method: "POST", body: Buffer.from('{"username":"secret-body"}') });
    expect(missingType.status).toBe(415); responses.push(await missingType.text()); errors++;
    await invalid(JSON.stringify({ username: "Guest", padding: "secret-padding" + " ".repeat(16 * 1024) }), 413);
    // No Content-Length: exceed the limit while streaming, retaining the socket for a 413.
    const chunked = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(`${url}/api/guest-login`, { method: "POST", headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked", Origin: url } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      });
      req.on("error", reject);
      req.write(" ".repeat(16 * 1024)); req.end("x");
    });
    expect(chunked.status).toBe(413); responses.push(chunked.text); errors++;
    const boundary = JSON.stringify({ username: "Boundary guest", padding: "" });
    const valid = await fetch(`${url}/api/guest-login`, {
      method: "POST", headers: { "Content-Type": "Application/JSON; charset=utf-8", Origin: url },
      body: boundary + " ".repeat(16 * 1024 - Buffer.byteLength(boundary))
    });
    expect(valid.status).toBe(201); await valid.json();
    expect(valid.headers.get("set-cookie")).toContain("HttpOnly");
    const reset = await fetch(`${url}/api/admin/reset`, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: "Bearer deployment-test-token", Origin: url
    }, body: "{}" });
    expect(reset.status).toBe(200); expect((await reset.json()).scope).toBe("runtime");
    const metricsResponse = await fetch(`${url}/api/admin/metrics`, { headers: { Authorization: "Bearer deployment-test-token" } });
    const snapshot = await metricsResponse.json();
    expect(snapshot.counters).toMatchObject({ http_errors_total: errors, http_client_errors_total: errors, http_server_errors_total: 0 });
    const text = JSON.stringify({ responses, events: snapshot.recentEvents });
    for (const secret of ["secret-body", "secret-padding", "secret-reset-body", "secret-reset-scope", "deployment-test-token", directory]) expect(text).not.toContain(secret);
    await stop(child);
  }, 15_000);

  it("preserves 401/403/404/429 and headers, generates IDs and counts every completed response once (TD-07)", async () => {
    const { child, ready } = launch({ HTTP_REQUESTS_PER_MINUTE: "4" });
    const url = await ready;
    const ids = new Set<string>();
    const cases: [string, RequestInit, number][] = [
      ["/api/me", {}, 401],
      ["/api/logout", { method: "POST", headers: { Origin: "https://secret-origin.example" } }, 403],
      ["/api/missing?secret-query=x", {}, 404],
      ["/api/me", { method: "OPTIONS", headers: { Origin: url } }, 204],
      ["/api/health", {}, 200],
      ["/", { headers: { Origin: url } }, 200],
      ["/api/me", {}, 429]
    ];
    for (const [path, options, status] of cases) {
      const response = await fetch(`${url}${path}`, { ...options, headers: { "X-Request-ID": "secret-client-id", ...options.headers } });
      expect(response.status).toBe(status);
      const id = response.headers.get("x-request-id")!;
      expect(id).toMatch(/^[0-9a-f-]{36}$/); expect(ids.has(id)).toBe(false); ids.add(id);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("set-cookie")).toBeNull();
      if (status === 429) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      if (status === 403) expect(response.headers.get("access-control-allow-origin")).toBeNull();
      if (options.headers && "Origin" in options.headers && options.headers.Origin === url) {
        expect(response.headers.get("access-control-allow-origin")).toBe(url);
        expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        expect(response.headers.get("access-control-expose-headers")).toBe("X-Request-ID");
      }
      await response.text();
    }
    const headers = { Authorization: "Bearer deployment-test-token", "X-Forwarded-For": "198.51.100.77" };
    const metricsResponse = await fetch(`${url}/api/admin/metrics`, { headers });
    const snapshot = await metricsResponse.json();
    expect(snapshot.counters).toMatchObject({ http_requests_total: cases.length, http_errors_total: 4, http_client_errors_total: 4, http_server_errors_total: 0, rate_limited_total: 1 });
    expect(JSON.stringify(snapshot.recentEvents)).not.toMatch(/secret-origin|secret-query|secret-client-id|deployment-test-token/);
    const prometheus = await (await fetch(`${url}/metrics`, { headers })).text();
    expect(prometheus).toContain("pixelfleet_http_client_errors_total 4");
    expect(prometheus).toContain("pixelfleet_http_server_errors_total 0");
    expect(prometheus).not.toMatch(/\{|secret-|requestId/);
    await stop(child);
  }, 15_000);

  it("isolates an HTTP storage failure with a correlated generic 500 and recovers after repair (TD-07)", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const player = await loginGuest(url, "HTTP failure dummy");
    const fixture = new DatabaseSync(join(directory, "pixelfleet.sqlite"));
    let response: Response;
    let failure: unknown;
    try {
      fixture.exec("ALTER TABLE sessions RENAME TO hidden_session_fixture");
      response = await fetch(`${url}/api/me?private=secret-query`, { headers: {
        Cookie: `${player.cookie}; private=secret-cookie`, Authorization: "Bearer secret-authorization",
        "X-Admin-Token": "secret-admin-header", "X-Request-ID": "secret-client-request-id"
      } });
      failure = await response.json();
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
    } finally {
      fixture.exec("ALTER TABLE hidden_session_fixture RENAME TO sessions");
      fixture.close();
    }
    const repaired = await fetch(`${url}/api/me`, { headers: { Cookie: player.cookie } });
    expect(repaired.status).toBe(200);
    expect((await repaired.json()).profile.userId).toBe(player.profile.userId);
    expect({ status: response!.status, body: failure }).toMatchObject({ status: 500, body: { error: "Internal server error." } });
    const id = response!.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(failure).toEqual({ error: "Internal server error.", requestId: id });
    const admin = await fetch(`${url}/api/admin/metrics`, { headers: { Authorization: "Bearer deployment-test-token" } });
    const diagnostics = await admin.json();
    expect(diagnostics.recentEvents).toContainEqual(expect.objectContaining({
      type: "error", requestId: id, route: "me", diagnostic: expect.objectContaining({ kind: "database", code: "ERR_SQLITE_ERROR" })
    }));
    const text = JSON.stringify({ failure, diagnostics });
    for (const secret of [player.cookie, "secret-query", "secret-cookie", "secret-authorization", "secret-admin-header", "secret-client-request-id", "hidden_session_fixture", directory, "no such table", "SELECT"]) {
      expect(text).not.toContain(secret);
    }
    expect(diagnostics.counters).toMatchObject({ http_errors_total: 1, http_client_errors_total: 0, http_server_errors_total: 1 });
    await stop(child);
  }, 15_000);

  it("returns a correlated generic 500 for a metrics gauge failure and recovers the Prometheus route (TD-07 review)", async () => {
    const { child, ready } = launch();
    const url = await ready;
    const headers = { Authorization: "Bearer deployment-test-token", "X-Request-ID": "secret-client-metrics-id" };
    const player = await loginGuest(url, "Metrics failure dummy");
    const unauthorized = await fetch(`${url}/metrics`);
    expect(unauthorized.status).toBe(401);
    await unauthorized.text();

    const fixture = new DatabaseSync(join(directory, "pixelfleet.sqlite"));
    let renamed = false;
    let requestId: string | null = null;
    let failure: unknown;
    try {
      fixture.exec("ALTER TABLE users RENAME TO secret_metrics_user_fixture");
      renamed = true;
      // A socket abort must fail this test, rather than substitute for the HTTP 500.
      const response = await fetch(`${url}/metrics`, { headers });
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      requestId = response.headers.get("x-request-id");
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(requestId).not.toBe(headers["X-Request-ID"]);
      failure = await response.json();
      expect(failure).toEqual({ error: "Internal server error.", requestId });
      expect((await fetch(`${url}/api/health`)).status).toBe(200);
    } finally {
      try {
        if (renamed) fixture.exec("ALTER TABLE secret_metrics_user_fixture RENAME TO users");
      } finally { fixture.close(); }
    }

    const recovered = await fetch(`${url}/metrics`, { headers });
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const prometheus = await recovered.text();
    expect(prometheus).toContain("# TYPE pixelfleet_users gauge\npixelfleet_users 1\n");
    expect(prometheus).toContain("# TYPE pixelfleet_sessions gauge\npixelfleet_sessions 1\n");
    expect(prometheus).toContain("pixelfleet_http_server_errors_total 1\n");
    const me = await fetch(`${url}/api/me`, { headers: { Cookie: player.cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).profile.userId).toBe(player.profile.userId);

    const admin = await fetch(`${url}/api/admin/metrics`, { headers });
    expect(admin.status).toBe(200);
    const diagnostics = await admin.json();
    expect(diagnostics.recentEvents).toEqual([expect.objectContaining({
      type: "error", requestId, method: "GET", route: "metrics", stage: "handler", responseState: "unstarted",
      diagnostic: expect.objectContaining({ kind: "database", code: "ERR_SQLITE_ERROR" })
    })]);
    expect(diagnostics.counters).toMatchObject({ http_errors_total: 2, http_client_errors_total: 1, http_server_errors_total: 1 });
    const text = JSON.stringify({ failure, events: diagnostics.recentEvents }) + prometheus;
    for (const secret of ["deployment-test-token", "secret-client-metrics-id", "secret_metrics_user_fixture", directory, "no such table", "SELECT"]) {
      expect(text).not.toContain(secret);
    }
    await stop(child);
  }, 15_000);

  it.each(["stats", "accounts"])("cancels pending rewards and retained results on an administrative %s reset (TD-05)", async (scope) => {
    const entrypoint = join(directory, "completion-clock.mjs");
    const serverUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/server.ts")).href;
    await writeFile(entrypoint, `
      import { mock } from "node:test";
      mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
      process.on("message", ({ tick }) => { mock.timers.tick(tick); process.send("ticked"); });
      await import(${JSON.stringify(serverUrl)});
    `);
    const { child, ready } = launch({}, entrypoint, true);
    const url = await ready;
    let players = [await loginGuest(url, "Reset first dummy"), await loginGuest(url, "Reset second dummy")];
    let clients = await Promise.all(players.map((p) => openSessionSocket(url, p.cookie)));
    const received: ServerMessage[] = [];
    clients[0].socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    const pairing = async () => {
      received.length = 0;
      for (const c of clients) c.socket.send(JSON.stringify({ type: "join_queue" }));
      await expect.poll(() => received.some((m) => m.type === "match_found")).toBe(true);
    };
    await pairing();
    clients[0].socket.send(JSON.stringify({ type: "leave_match" }));
    await expect.poll(() => received.some((m) => m.type === "match_finished")).toBe(true);
    const fixture = new DatabaseSync(join(directory, "pixelfleet.sqlite"));
    try {
      const receipts = () => fixture.prepare("SELECT COUNT(*) AS count FROM match_completions").get()!.count;
      expect(receipts()).toBe(1);
      const saved = fixture.prepare("SELECT match_id, decision_json FROM match_completions").get()!;
      fixture.exec(`CREATE TRIGGER fail_second_completion BEFORE UPDATE OF games_played ON users
        WHEN (SELECT SUM(games_played) FROM users) > 2
        BEGIN SELECT RAISE(ABORT, 'injected reset fixture failure'); END;`);
      await pairing();
      clients[0].socket.send(JSON.stringify({ type: "leave_match" }));
      await expect.poll(() => received.some((m) => m.type === "game_update" && m.view.phase === "saving")).toBe(true);
      const closed = clients.map((c) => once(c.socket, "close"));
      const reset = await fetch(`${url}/api/admin/reset`, {
        method: "POST", headers: { Authorization: "Bearer deployment-test-token", Origin: url, "Content-Type": "application/json" },
        body: JSON.stringify({ scope })
      });
      expect(reset.status).toBe(200);
      expect((await reset.json()).hub).toMatchObject({ matches: 0, activeConnections: 0, finishedMatches: 0 });
      expect((await Promise.all(closed)).map((r) => r[0])).toEqual([4009, 4009]);
      expect(receipts()).toBe(1);
      expect(fixture.prepare("SELECT match_id, decision_json FROM match_completions").get()).toEqual(saved);
      fixture.exec("DROP TRIGGER fail_second_completion");
      if (scope === "accounts") players = [await loginGuest(url, "New first dummy"), await loginGuest(url, "New second dummy")];
      clients = await Promise.all(players.map((p) => openSessionSocket(url, p.cookie)));
      clients[0].socket.on("message", (data) => received.push(JSON.parse(data.toString())));
      await pairing();
      const advanced = once(child, "message");
      child.send!({ tick: 5000 });
      await advanced;
      expect(receipts()).toBe(1);
      expect(fixture.prepare("SELECT SUM(games_played) AS games, SUM(xp) AS xp FROM users").get()).toMatchObject({ games: 0, xp: 0 });
      const health = await fetch(`${url}/api/health`);
      expect((await health.json()).hub).toMatchObject({ placingMatches: 1, finishedMatches: 0 });
      clients[0].socket.send(JSON.stringify({ type: "leave_match" }));
      await expect.poll(() => received.some((m) => m.type === "match_finished")).toBe(true);
      expect(receipts()).toBe(2);
      expect(fixture.prepare("SELECT SUM(games_played) AS games FROM users").get()!.games).toBe(2);
      const ended = clients.map((c) => once(c.socket, "close"));
      await stop(child);
      await Promise.all(ended);
    } finally { fixture.close(); }
  }, 15_000);

  it("periodically prunes all HTTP and hub quotas without requests and keeps cleanup after admin reset (TD-04)", async () => {
    // Observe private bucket sizes only in this disposable process; no production diagnostics hook.
    const entrypoint = join(directory, "quota-clock.mjs");
    const limiterUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/rate-limit.ts")).href;
    const serverUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/server.ts")).href;
    await writeFile(entrypoint, `
      import { mock } from "node:test";
      mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
      const intervals = new Set();
      const setInterval = globalThis.setInterval;
      const clearInterval = globalThis.clearInterval;
      globalThis.setInterval = (...args) => {
        const timer = setInterval(...args); intervals.add(timer); return timer;
      };
      globalThis.clearInterval = (timer) => { intervals.delete(timer); clearInterval(timer); };
      process.on("exit", () => console.log("Remaining intervals: " + intervals.size));
      const { FixedWindowRateLimiter } = await import(${JSON.stringify(limiterUrl)});
      const observed = new Set();
      const original = FixedWindowRateLimiter.prototype.check;
      FixedWindowRateLimiter.prototype.check = function (...args) {
        observed.add(this);
        return original.apply(this, args);
      };
      process.on("message", ({ tick = 0, seed = false }) => {
        mock.timers.tick(tick);
        if (seed) for (const limiter of observed) {
          for (let i = 0; i < 1000; i++) limiter.check("synthetic-" + Date.now() + "-" + i);
        }
        process.send({ intervals: intervals.size, entries: [...observed].map(limiter => ({
          limit: limiter.options.limit, windowMs: limiter.options.windowMs,
          size: limiter.buckets.size, now: Date.now()
        })) });
      });
      await import(${JSON.stringify(serverUrl)});
    `);
    const { child, ready, output } = launch({}, entrypoint, true);
    const url = await ready;
    const login = await loginGuest(url, "Quota lifecycle dummy");
    expect((await fetch(`${url}/api/admin/status`, { headers: { Authorization: "Bearer deployment-test-token" } })).status).toBe(200);
    const { socket } = await openSessionSocket(url, login.cookie);
    const reply = once(socket, "message");
    socket.send(JSON.stringify({ type: "cancel_queue" }));
    await reply;
    const invalid = once(socket, "message");
    socket.send(JSON.stringify({ type: "fire", x: 0, y: 0 }));
    await invalid;
    const closed = once(socket, "close");
    socket.close(); await closed;
    type Inventory = { limit: number; windowMs: number; size: number; now: number }[];
    async function clock(tick = 0, seed = false): Promise<Inventory> {
      const acknowledged = once(child, "message");
      child.send!({ tick, seed });
      const snapshot = (await acknowledged)[0] as { intervals: number; entries: Inventory };
      expect(snapshot.intervals).toBe(2); // Heartbeat and exactly one quota cleanup, also after reset.
      return snapshot.entries;
    }
    const initial = await clock(0, true);
    expect(initial.filter((entry) => entry.limit !== 7).map((entry) => [entry.limit, entry.windowMs]).sort()).toEqual([
      [240, 60_000], [12, 3_600_000], [60, 60_000], [30, 60_000],
      [120, 10_000], [12, 60_000], [120, 10_000]
    ].sort());
    expect(initial.every((entry) => entry.size >= 1000)).toBe(true);
    const halfway = await clock(30_000);
    expect(halfway.filter((entry) => entry.windowMs === 10_000).every((entry) => entry.size === 0)).toBe(true);
    expect(halfway.filter((entry) => entry.windowMs >= 60_000).every((entry) => entry.size >= 1000)).toBe(true);
    expect(halfway.find((entry) => entry.limit === 7)).toBeDefined();
    await clock(0, true); // Fresh keys must not be evicted at the older keys' boundary.
    const minute = await clock(30_000);
    expect(minute.filter((entry) => entry.windowMs === 10_000).every((entry) => entry.size === 0)).toBe(true);
    expect(minute.filter((entry) => entry.windowMs === 60_000).every((entry) => entry.size === 1000)).toBe(true);
    expect(minute.find((entry) => entry.windowMs === 3_600_000)!.size).toBeGreaterThanOrEqual(2000);
    const hour = await clock(3_570_000);
    expect(hour.every((entry) => entry.size === 0)).toBe(true);
    const reset = await fetch(`${url}/api/admin/reset`, {
      method: "POST", headers: { Authorization: "Bearer deployment-test-token", Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "runtime" })
    });
    expect(reset.status).toBe(200); await reset.json();
    const current = await openSessionSocket(url, login.cookie);
    const errored = once(current.socket, "message");
    current.socket.send("not-json"); await errored;
    const ended = once(current.socket, "close");
    current.socket.close(); await ended;
    const next = await clock(60_000);
    expect(next.every((entry) => entry.size === 0)).toBe(true);
    await stop(child);
    expect(output()).toContain("Remaining intervals: 0");
  }, 15_000);

  it.each([
    { name: "invalid UTF-8", limit: undefined, send: (socket: WebSocket) => socket.send(Buffer.from([0xff]), { binary: false }) },
    { name: "reserved opcode", limit: undefined, send: (socket: WebSocket) => writeFrame(socket, Buffer.from([0x83, 0x80, 0, 0, 0, 0])) },
    { name: "oversized default payload", limit: undefined, send: (socket: WebSocket) => writeFrame(socket, oversizedFrameHeader(4097)) },
    { name: "oversized configured payload", limit: "512", send: (socket: WebSocket) => writeFrame(socket, oversizedFrameHeader(513)) },
    { name: "oversized fragmented payload", limit: "512", send: (socket: WebSocket) => {
      socket.send(" ".repeat(256), { fin: false });
      writeFrame(socket, oversizedFrameHeader(257, 0x80));
    } }
  ])("isolates $name while other clients keep playing and connection slots recover", async ({ limit, send }) => {
    const { child, ready, output } = launch({ MAX_WS_PER_IP: "3", ...(limit ? { MAX_WS_PAYLOAD_BYTES: limit } : {}) });
    const url = await ready;
    const first = await loginGuest(url, "Valid first guest");
    const second = await loginGuest(url, "Valid second guest");
    const affected = await loginGuest(url, "Transport error guest");
    const a = (await openSessionSocket(url, first.cookie)).socket;
    const b = (await openSessionSocket(url, second.cookie)).socket;
    const bad = (await openSessionSocket(url, affected.cookie)).socket;
    const received: ServerMessage[][] = [[], []];
    [a, b].forEach((socket, index) => socket.on("message", (data) => received[index].push(JSON.parse(data.toString()))));
    const latestView = (index: number) => received[index].filter((message) => message.type === "game_update").at(-1)?.view;
    a.send(JSON.stringify({ type: "join_queue" }));
    b.send(JSON.stringify({ type: "join_queue" }));
    await expect.poll(() => latestView(0)?.phase).toBe("placing");
    const placements = [
      { shipId: "battleship", x: 0, y: 0, orientation: "horizontal" },
      { shipId: "cruiser", x: 0, y: 2, orientation: "horizontal" },
      { shipId: "destroyer-a", x: 0, y: 4, orientation: "horizontal" },
      { shipId: "destroyer-b", x: 0, y: 6, orientation: "horizontal" },
      { shipId: "submarine", x: 0, y: 8, orientation: "horizontal" }
    ];
    for (const socket of [a, b]) socket.send(JSON.stringify({ type: "place_ships", placements }));
    await expect.poll(() => latestView(0)?.phase).toBe("playing");

    // A valid UTF-8 message exactly at the byte limit must still be accepted.
    const action = JSON.stringify({ type: "join_queue", padding: "é" });
    const boundaryMessage = action + " ".repeat(Number(limit ?? 4096) - Buffer.byteLength(action));
    const queued = once(bad, "message");
    bad.send(boundaryMessage);
    expect(JSON.parse((await queued)[0].toString())).toMatchObject({ type: "queue_status", queued: true });
    const closed = once(bad, "close", { signal: AbortSignal.timeout(2000) });
    send(bad);
    await closed;
    expect(bad.readyState).toBe(WebSocket.CLOSED);
    // A crash remains confined to this child; include its stderr in the failure.
    const health = await fetch(`${url}/api/health`).catch((error) => {
      throw new Error(`Backend failed after malformed frame: ${output()}`, { cause: error });
    });
    expect(health.status).toBe(200);
    expect(child.exitCode, output()).toBeNull();
    await expect.poll(async () => (await (await fetch(`${url}/api/health`)).json()).hub).toMatchObject({
      activeConnections: 2, queuedPlayers: 0, playingMatches: 1
    });
    const turn = latestView(0)!.currentTurnUserId;
    (turn === first.profile.userId ? a : b).send(JSON.stringify({ type: "fire", x: 0, y: 0 }));
    await expect.poll(() => latestView(0)?.currentTurnUserId).not.toBe(turn);
    await expect.poll(() => latestView(1)?.currentTurnUserId).not.toBe(turn);
    expect([a.readyState, b.readyState]).toEqual([WebSocket.OPEN, WebSocket.OPEN]);
    expect(received.flat().some((message) => message.type === "error")).toBe(false);

    const recovered = await openSessionSocket(url, affected.cookie);
    const cancelled = once(recovered.socket, "message");
    recovered.socket.send(JSON.stringify({ type: "cancel_queue" }));
    expect(JSON.parse((await cancelled)[0].toString())).toMatchObject({ type: "queue_status", queued: false });
    expect(await rejectedUpgrade(url, first.cookie)).toBe(429);
    await stop(child);
  }, 15_000);

  it("handles repeated socket errors before hub initialization without releasing another client's slot", async () => {
    const entrypoint = join(directory, "early-socket-errors.mjs");
    const hubUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/game-hub.ts")).href;
    const serverUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/server.ts")).href;
    await writeFile(entrypoint, `
      const { GameHub } = await import(${JSON.stringify(hubUrl)});
      const originalConnect = GameHub.prototype.connect;
      let connections = 0;
      GameHub.prototype.connect = function (ws, ...args) {
        if (++connections !== 2) return originalConnect.call(this, ws, ...args);
        queueMicrotask(() => {
          ws.emit("error", new Error("First initialization transport failure"));
          ws.emit("error", new Error("Repeated initialization transport failure"));
        });
      };
      await import(${JSON.stringify(serverUrl)});
    `);
    const { child, ready } = launch({ MAX_WS_PER_IP: "2" }, entrypoint);
    const url = await ready;
    const first = await loginGuest(url, "Stable transport guest");
    const second = await loginGuest(url, "Early error guest");
    const stable = await openSessionSocket(url, first.cookie);
    const failed = new WebSocket(`${url.replace("http:", "ws:")}/ws`, WS_PROTOCOL, {
      headers: { Cookie: second.cookie, Origin: url }, handshakeTimeout: 2_000
    });
    sockets.push(failed);
    failed.on("error", () => {});
    await new Promise<void>((resolve) => failed.once("close", () => resolve()));
    await expect.poll(async () => (await (await fetch(`${url}/api/health`)).json()).hub.activeConnections).toBe(1);
    const recovered = await openSessionSocket(url, second.cookie);
    expect(recovered.profile.userId).toBe(second.profile.userId);
    expect(await rejectedUpgrade(url, first.cookie)).toBe(429);
    const reply = once(stable.socket, "message");
    stable.socket.send(JSON.stringify({ type: "cancel_queue" }));
    expect(JSON.parse((await reply)[0].toString())).toMatchObject({ type: "queue_status", queued: false });
    await stop(child);
  }, 15_000);

  it("enforces an existing session's fixed deadline for HTTP and upgrades, expires an idle socket and retains account data", async () => {
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    const yearMs = 365 * 24 * 60 * 60 * 1000;
    // Clock control exists only in this disposable test process, never in the application.
    // Only Date is mocked: expiry uses real Node timers and native WebSocket close events.
    const entrypoint = join(directory, "expiry-clock.mjs");
    const serverUrl = pathToFileURL(join(process.cwd(), "apps/backend/src/server.ts")).href;
    await writeFile(entrypoint, `
      import { mock } from "node:test";
      mock.timers.enable({ apis: ["Date"], now: ${start} });
      process.on("message", ({ now }) => {
        mock.timers.setTime(now);
        process.send({ now: Date.now() });
      });
      await import(${JSON.stringify(serverUrl)});
    `);
    const { child, ready } = launch({}, entrypoint, true);
    const url = await ready;
    async function clock(now: number) {
      const acknowledged = once(child, "message");
      child.send!({ now });
      expect((await acknowledged)[0]).toEqual({ now });
    }
    const player = await loginGuest(url, "Legacy expiry dummy");
    const token = player.cookie.slice("pf_session=".length);
    const hash = createHash("sha256").update(token).digest("hex");
    const expiresAt = start + 1000;
    const createdAt = new Date(expiresAt - yearMs).toISOString();
    const fixtureDatabase = new DatabaseSync(join(directory, "pixelfleet.sqlite"));
    try {
      fixtureDatabase.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE token_hash = ?")
        .run(createdAt, createdAt, hash);
      fixtureDatabase.prepare("UPDATE users SET xp = 123, wins = 1, games_played = 1 WHERE user_id = ?")
        .run(player.profile.userId);
      const opened = await openSessionSocket(url, player.cookie);
      const closed = once(opened.socket, "close");
      await clock(expiresAt - 1);
      const before = await fetch(`${url}/api/me`, { headers: { Cookie: player.cookie } });
      expect(before.status).toBe(200);
      expect((await before.json()).profile).toMatchObject({ userId: player.profile.userId, xp: 123, stats: { wins: 1 } });
      const reused = await fetch(`${url}/api/guest-login`, {
        method: "POST", headers: { Cookie: player.cookie, Origin: url }
      });
      expect(reused.status).toBe(200);
      expect(reused.headers.get("set-cookie")).toBeNull(); // activity does not reissue a full-year cookie
      await reused.json();
      // Authenticate one more new socket immediately before the boundary.
      const replacement = await openSessionSocket(url, player.cookie);
      expect((await closed)[0]).toBe(4001);
      const expired = once(replacement.socket, "close");
      await clock(expiresAt);
      expect((await expired)[0]).toBe(4003); // no additional WebSocket message
      for (const now of [expiresAt, expiresAt + 1]) {
        await clock(now);
        const me = await fetch(`${url}/api/me`, { headers: { Cookie: player.cookie } });
        expect(me.status).toBe(401);
        await me.json();
        expect(await rejectedUpgrade(url, player.cookie)).toBe(401);
      }
      expect(fixtureDatabase.prepare("SELECT created_at FROM sessions WHERE token_hash = ?").get(hash)).toEqual({ created_at: createdAt });
      expect(fixtureDatabase.prepare("SELECT xp, wins, games_played FROM users WHERE user_id = ?").get(player.profile.userId))
        .toEqual({ xp: 123, wins: 1, games_played: 1 });
      const fresh = await fetch(`${url}/api/guest-login`, {
        method: "POST", headers: { Cookie: player.cookie, Origin: url, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Legacy expiry dummy" })
      });
      expect(fresh.status).toBe(201);
      expect(fresh.headers.get("set-cookie")).toContain("Max-Age=31536000;");
      expect((await fresh.json()).profile.userId).not.toBe(player.profile.userId);
      const health = await fetch(`${url}/api/health`);
      expect((await health.json()).hub.activeConnections).toBe(0);
    } finally {
      fixtureDatabase.close();
    }
    await stop(child);
  }, 15_000);

  it.each(["false", "true"])("keeps login and logout cookie attributes consistent with TRUST_PROXY=%s", async (trust) => {
    const { child, ready } = launch({ TRUST_PROXY: trust });
    const url = await ready;
    for (const proto of [undefined, "http", "https"]) {
      const headers = { Origin: url, ...(proto ? { "X-Forwarded-Proto": proto } : {}) };
      const login = await fetch(`${url}/api/guest-login`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Transport policy dummy" })
      });
      expect(login.status).toBe(201);
      const issued = login.headers.get("set-cookie")!.split("; ");
      await login.json();
      const logout = await fetch(`${url}/api/logout`, {
        method: "POST", headers: { ...headers, Cookie: issued[0] }
      });
      expect(logout.status).toBe(200);
      expect(await logout.json()).toEqual({ ok: true });
      const cleared = logout.headers.get("set-cookie")!.split("; ");
      const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", ...(trust === "true" && proto === "https" ? ["Secure"] : [])];
      expect(issued[0]).toMatch(/^pf_session=.+/);
      expect(cleared[0]).toBe("pf_session=");
      const maxAge = Number(issued.find((part) => part.startsWith("Max-Age="))?.slice("Max-Age=".length));
      expect(maxAge).toBeGreaterThanOrEqual(31535999);
      expect(maxAge).toBeLessThanOrEqual(31536000);
      expect(cleared).toContain("Max-Age=0");
      expect(issued.slice(1).filter((part) => !part.startsWith("Max-Age="))).toEqual(attributes);
      expect(cleared.slice(1).filter((part) => !part.startsWith("Max-Age="))).toEqual(attributes);
    }
    await stop(child);
  }, 15_000);

  it.each(["false", "true"])("uses the selected client IP for HTTP quotas with TRUST_PROXY=%s", async (trust) => {
    const { child, ready } = launch({ TRUST_PROXY: trust, HTTP_REQUESTS_PER_MINUTE: "1" });
    const url = await ready;
    for (const [index, ip] of ["203.0.113.7", "203.0.113.8"].entries()) {
      const login = await fetch(`${url}/api/guest-login`, {
        method: "POST",
        headers: { Origin: url, "X-Forwarded-For": ip, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "HTTP quota dummy" })
      });
      expect(login.status).toBe(index === 0 || trust === "true" ? 201 : 429);
      await login.json();
    }
    await stop(child);
  }, 15_000);

  it.each(["false", "true"])("uses the selected client IP for WebSocket caps with TRUST_PROXY=%s", async (trust) => {
    const { child, ready } = launch({ TRUST_PROXY: trust, MAX_WS_PER_IP: "1" });
    const url = await ready;
    const first = await loginGuest(url, "First quota dummy");
    const second = await loginGuest(url, "Second quota dummy");
    const stable = await openSessionSocket(url, first.cookie, url, { "X-Forwarded-For": "203.0.113.7" });
    if (trust === "true") {
      const other = await openSessionSocket(url, second.cookie, url, { "X-Forwarded-For": "203.0.113.8" });
      expect(other.profile.userId).toBe(second.profile.userId);
    } else {
      expect(await rejectedUpgrade(url, second.cookie, url, { "X-Forwarded-For": "203.0.113.8" })).toBe(429);
    }
    expect(stable.socket.readyState).toBe(WebSocket.OPEN);
    const health = await fetch(`${url}/api/health`);
    expect((await health.json()).hub.activeConnections).toBe(trust === "true" ? 2 : 1);
    await stop(child);
  }, 15_000);

  it.each(["development", "production"])("keeps HTTP, CORS and WebSocket origin decisions consistent in %s", async (mode) => {
    const { child, ready } = launch({ NODE_ENV: mode });
    const url = await ready;
    const { cookie, profile } = await loginGuest(url, "Origin policy dummy");
    const origins: [string, boolean][] = [
      ["http://localhost:5173", true], ["https://app.localhost:5179", true],
      ["http://192.168.1.251:5174", true], ["http://[::1]:5173", true],
      ["http://[fd00::1]:5173", true], ["http://[fe80::1]:5173", true],
      ["http://fc-assets.example:5173", false], ["http://fd-cdn.example:5173", false],
      ["http://localhost:5180", false], ["http://[2001:db8::1]:5173", false],
      ["http://[fdgg::1]:5173", false], [url, true]
    ];
    for (const [origin, devAllowed] of origins) {
      const allowed = origin === url || (mode === "development" && devAllowed);
      const preflight = await fetch(`${url}/api/guest-login`, { method: "OPTIONS", headers: { Origin: origin } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed ? origin : null);
      expect(preflight.headers.get("access-control-allow-credentials")).toBe(allowed ? "true" : null);
      await preflight.text();
      const login = await fetch(`${url}/api/guest-login`, {
        method: "POST", headers: { Origin: origin, Cookie: cookie }
      });
      expect(login.status).toBe(allowed ? 200 : 403);
      expect(login.headers.get("access-control-allow-origin")).toBe(allowed ? origin : null);
      const body = await login.json();
      if (allowed) {
        expect(body.profile.userId).toBe(profile.userId);
        const { socket, profile: socketProfile } = await openSessionSocket(url, cookie, origin);
        expect(socketProfile.userId).toBe(profile.userId);
        const closed = once(socket, "close");
        socket.close();
        await closed;
      } else {
        expect(body.error).toBe("Untrusted origin.");
        expect(await rejectedUpgrade(url, cookie, origin)).toBe(403);
      }
    }
    await stop(child);
  }, 15_000);

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
          const received = JSON.parse(data.toString()) as ServerMessage;
          const message = received.type === "session_snapshot" && received.state.kind === "match"
            ? { type: "game_update" as const, view: received.state.view } : received;
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
    const current = new WebSocket(`${url.replace("http:", "ws:")}/ws`, WS_PROTOCOL, {
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
    const failed = new WebSocket(`${url.replace("http:", "ws:")}/ws`, WS_PROTOCOL, {
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

    const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, WS_PROTOCOL, {
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
    const opponent = new WebSocket(`${url.replace("http:", "ws:")}/ws`, WS_PROTOCOL, {
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
    const resumed = await openSessionSocket(restartedUrl, cookie.split(";")[0]);
    expect(resumed.snapshot).toEqual({ type: "session_snapshot", profile: persisted, state: { kind: "lobby" } });
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
