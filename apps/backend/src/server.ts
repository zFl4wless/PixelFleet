import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { frontendPageFromPath, WS_PROTOCOL } from "@pixelfleet/shared";
import {
  closeDatabase,
  createGuestAccount,
  deleteSession,
  getDatabaseStats,
  getProfileBySessionToken,
  getSessionByToken,
  resetDatabase,
  type ResetScope
} from "./db.js";
import {
  clearSessionCookie,
  canRespond,
  getClientIp,
  getSessionToken,
  InvalidCookieError,
  isTrustedOrigin,
  isSecureRequest,
  readJson,
  requireJsonObject,
  sendJson,
  sessionCookie,
  setCors,
  setSecurityHeaders
} from "./http.js";
import { GameHub, MAX_WS_PAYLOAD_BYTES } from "./game-hub.js";
import { metrics } from "./metrics.js";
import type { HttpErrorContext } from "./metrics.js";
import { PublicInputError } from "./input-errors.js";
import { FixedWindowRateLimiter, parseEnvInt, startRateLimitCleanup } from "./rate-limit.js";

const port = Number(process.env.PORT ?? 3001);
const hub = new GameHub();
const frontendDistDir = process.env.FRONTEND_DIST_DIR ?? join(process.cwd(), "apps/frontend/dist");
const adminToken = process.env.ADMIN_TOKEN;
let shuttingDown = false;

// A production container must not become healthy without the built frontend.
if (process.env.NODE_ENV === "production") {
  const index = await stat(join(frontendDistDir, "index.html"));
  if (!index.isFile()) {
    throw new Error("Production frontend index.html is missing. Run npm run build first.");
  }
}
const publicLimiter = new FixedWindowRateLimiter({
  limit: parseEnvInt("HTTP_REQUESTS_PER_MINUTE", 240),
  windowMs: 60_000
});
const loginLimiter = new FixedWindowRateLimiter({
  limit: parseEnvInt("GUEST_LOGINS_PER_HOUR", 12),
  windowMs: 60 * 60 * 1000
});
const adminLimiter = new FixedWindowRateLimiter({
  limit: parseEnvInt("ADMIN_REQUESTS_PER_MINUTE", 60),
  windowMs: 60_000
});
const wsConnectLimiter = new FixedWindowRateLimiter({
  limit: parseEnvInt("WS_CONNECTS_PER_MINUTE", 30),
  windowMs: 60_000
});
const stopRateLimitCleanup = startRateLimitCleanup((now) => {
  for (const limiter of [publicLimiter, loginLimiter, adminLimiter, wsConnectLimiter]) limiter.prune(now);
  hub.pruneRateLimits(now);
});
const activeWsByIp = new Map<string, number>();
const maxWsPerIp = parseEnvInt("MAX_WS_PER_IP", 20);
const noIndexPaths = new Set(["/legal-notice", "/privacy-policy"]);

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function pathname(reqUrl: string | undefined): string {
  try {
    return new URL(reqUrl ?? "/", "http://localhost").pathname;
  } catch {
    throw new PublicInputError("invalid_url");
  }
}

function requestRoute(path: string): HttpErrorContext["route"] {
  switch (path) {
    case "/api/health": return "health";
    case "/api/me": return "me";
    case "/api/guest-login": return "guest-login";
    case "/api/logout": return "logout";
    case "/api/admin/status": return "admin-status";
    case "/api/admin/metrics": return "admin-metrics";
    case "/api/admin/reset": return "admin-reset";
    case "/metrics": return "metrics";
    default: return path.startsWith("/api/admin") ? "admin-other" : path === "/api" || path.startsWith("/api/") || path.startsWith("/ws") ? "api-other" : "static";
  }
}

function isNoIndexPath(path: string): boolean {
  const normalizedPath = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return noIndexPaths.has(normalizedPath);
}

function rateLimit(res: import("node:http").ServerResponse, limiter: FixedWindowRateLimiter, key: string): boolean {
  const result = limiter.check(key);
  if (result.allowed) {
    return false;
  }

  metrics.inc("rate_limited_total");
  res.setHeader("Retry-After", Math.ceil(result.retryAfterMs / 1000).toString());
  sendJson(res, 429, { error: "Too many requests. Try again shortly." });
  return true;
}

function isAdminRequest(req: import("node:http").IncomingMessage): boolean {
  if (!adminToken) {
    return false;
  }

  const authorization = req.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
  const headerToken = req.headers["x-admin-token"];
  return bearer === adminToken || headerToken === adminToken;
}

function requireAdmin(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): boolean {
  if (!adminToken) {
    sendJson(res, 503, { error: "Admin API is disabled. Set ADMIN_TOKEN to enable it." });
    return false;
  }

  if (!isAdminRequest(req)) {
    sendJson(res, 401, { error: "Admin token required." });
    return false;
  }

  return true;
}

function metricGauges(): Record<string, number> {
  const hubStats = hub.stats();
  const dbStats = getDatabaseStats();
  return {
    active_connections: hubStats.activeConnections,
    queued_players: hubStats.queuedPlayers,
    active_matches: hubStats.matches,
    placing_matches: hubStats.placingMatches,
    playing_matches: hubStats.playingMatches,
    users: dbStats.users,
    sessions: dbStats.sessions
  };
}

async function handleAdminRoute(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  path: string,
  ip: string
): Promise<boolean> {
  if (!path.startsWith("/api/admin") && path !== "/metrics") {
    return false;
  }

  if (rateLimit(res, adminLimiter, `admin:${ip}`)) {
    return true;
  }

  if (!requireAdmin(req, res)) {
    return true;
  }

  if (req.method === "GET" && path === "/api/admin/status") {
    sendJson(res, 200, {
      ok: true,
      hub: hub.stats(),
      database: getDatabaseStats(),
      metrics: metrics.snapshot()
    });
    return true;
  }

  if (req.method === "GET" && path === "/api/admin/metrics") {
    sendJson(res, 200, metrics.snapshot({ hub: hub.stats(), database: getDatabaseStats() }));
    return true;
  }

  if (req.method === "GET" && path === "/metrics") {
    const text = metrics.prometheus(metricGauges());
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(text);
    return true;
  }

  if (req.method === "POST" && path === "/api/admin/reset") {
    const body = requireJsonObject(await readJson(req));
    if (!canRespond(res)) return true;
    const value = body.scope === undefined ? "runtime" : body.scope;
    const allowedScopes = new Set(["accounts", "all", "runtime", "sessions", "stats"]);

    if (typeof value !== "string" || !allowedScopes.has(value)) throw new PublicInputError("invalid_reset_scope");
    const scope = value as ResetScope | "runtime";

    let database = getDatabaseStats();
    if (scope === "runtime") {
      hub.resetRuntime();
    } else {
      // Cancel pending completions and retained profiles before resetting totals too.
      hub.resetRuntime();
      database = resetDatabase(scope);
    }

    metrics.inc("admin_actions_total");
    metrics.event("admin", `Admin reset executed: ${scope}`);
    sendJson(res, 200, {
      ok: true,
      scope,
      hub: hub.stats(),
      database
    });
    return true;
  }

  sendJson(res, 404, { error: "Admin route not found." });
  return true;
}

async function serveStatic(reqUrl: string | undefined, res: import("node:http").ServerResponse): Promise<boolean> {
  const url = new URL(reqUrl ?? "/", "http://localhost");
  let requestedPath: string;
  try { requestedPath = decodeURIComponent(url.pathname); }
  catch { throw new PublicInputError("invalid_url"); }

  if (requestedPath === "/api" || requestedPath.startsWith("/api/") || requestedPath === "/ws" || requestedPath.startsWith("/ws/")) {
    return false;
  }

  const normalizedPath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(frontendDistDir, normalizedPath === sep ? "index.html" : normalizedPath);
  const safeRoot = normalize(frontendDistDir + sep);
  const safeCandidate = normalize(candidate);

  if (!safeCandidate.startsWith(safeRoot)) {
    sendJson(res, 403, { error: "Forbidden." });
    return true;
  }

  const page = frontendPageFromPath(url.pathname);
  let status = 200;
  let filePath: string;

  if (page === "game") {
    filePath = join(frontendDistDir, "index.html");
  } else if (page !== "not-found") {
    filePath = join(frontendDistDir, page, "index.html");
  } else {
    const fileStat = await stat(safeCandidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (fileStat?.isFile() && extname(safeCandidate) !== ".html" && mimeTypes[extname(safeCandidate)]) {
      filePath = safeCandidate;
    } else if (requestedPath.startsWith("/assets/") || (extname(requestedPath) && extname(requestedPath) !== ".html")) {
      // Missing resources must not receive an HTML app shell.
      return false;
    } else {
      status = 404;
      filePath = join(frontendDistDir, "404.html");
    }
  }

  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
    throw error;
  }

  // Opening can fail after stat succeeds. Wait before committing response headers.
  const file = await open(filePath, "r");
  try {
    if (!canRespond(res)) return true;
    res.writeHead(status, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      ...(status === 404 || isNoIndexPath(requestedPath) || page === "legal-notice" || page === "privacy-policy"
        ? { "X-Robots-Tag": "noindex, nofollow, noarchive" } : {})
    });
    // Read/response errors and client disconnects are awaited inside the HTTP boundary.
    await pipeline(file.createReadStream(), res);
  } finally { await file.close(); }
  return true;
}

const server = createServer(async (req, res) => {
  const context: HttpErrorContext = { requestId: "", method: undefined, route: "unknown", stage: "preparation", responseState: "unstarted" };
  try {
    context.requestId = randomUUID();
    context.method = req.method;
    metrics.trackResponse(res);
    res.setHeader("X-Request-ID", context.requestId);
    setSecurityHeaders(res);
    setCors(req, res);
    const ip = getClientIp(req);
    const path = pathname(req.url);
    context.route = requestRoute(path);
    context.stage = "handler";

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // Container probes must remain available when a visitor hits their rate limit.
    if (req.method === "GET" && path === "/api/health") {
      sendJson(res, shuttingDown ? 503 : 200, {
        ok: !shuttingDown,
        name: "Pixel Fleet",
        uptimeSeconds: Math.round(process.uptime()),
        hub: hub.stats()
      });
      return;
    }

    if (rateLimit(res, publicLimiter, `http:${ip}`)) {
      return;
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && !isTrustedOrigin(req)) {
      metrics.event("security", "Blocked untrusted HTTP origin.");
      sendJson(res, 403, { error: "Untrusted origin." });
      return;
    }

    if (await handleAdminRoute(req, res, path, ip)) {
      return;
    }

    if (req.method === "GET" && path === "/api/me") {
      const profile = getProfileBySessionToken(getSessionToken(req));
      if (!profile) {
        sendJson(res, 401, { error: "Not logged in." });
        return;
      }
      sendJson(res, 200, { profile });
      return;
    }

    if (req.method === "POST" && path === "/api/guest-login") {
      const existing = getProfileBySessionToken(getSessionToken(req));
      if (existing) {
        sendJson(res, 200, { profile: existing });
        return;
      }

      if (rateLimit(res, loginLimiter, `login:${ip}`)) {
        return;
      }

      const body = requireJsonObject(await readJson(req));
      if (!canRespond(res)) return;
      const username = body.username === undefined ? "" : body.username;
      if (typeof username !== "string") throw new PublicInputError("invalid_username_type");
      const { profile, sessionToken, expiresAt } = createGuestAccount(username);
      metrics.inc("guest_accounts_created_total");
      res.setHeader("Set-Cookie", sessionCookie(sessionToken, isSecureRequest(req), expiresAt));
      sendJson(res, 201, { profile });
      return;
    }

    if (req.method === "POST" && path === "/api/logout") {
      const sessionId = deleteSession(getSessionToken(req));
      if (sessionId) {
        hub.revokeSession(sessionId);
      }
      res.setHeader("Set-Cookie", clearSessionCookie(isSecureRequest(req)));
      sendJson(res, 200, { ok: true });
      return;
    }

    context.stage = "static";
    if (await serveStatic(req.url, res)) {
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    if (error instanceof PublicInputError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    context.responseState = res.destroyed || res.writableEnded ? "closed" : res.headersSent ? "started" : "unstarted";
    metrics.httpError(context, error);
    if (canRespond(res)) sendJson(res, 500, { error: "Internal server error.", requestId: context.requestId });
    else if (!res.destroyed && !res.writableEnded) res.destroy();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
type HeartbeatSocket = WebSocket & { isAlive?: boolean };

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients as Set<HeartbeatSocket>) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.on("close", () => {
  clearInterval(heartbeatInterval);
  stopRateLimitCleanup();
});

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  status: "400 Bad Request" | "401 Unauthorized" | "403 Forbidden" | "429 Too Many Requests" | "500 Internal Server Error",
  retryAfter?: number
): void {
  if (socket.destroyed) {
    return;
  }
  if (socket.writableEnded) {
    socket.destroy();
    return;
  }
  const retryHeader = retryAfter === undefined ? "" : `Retry-After: ${retryAfter}\r\n`;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${retryHeader}\r\n`, () => socket.destroy());
}

server.on("upgrade", (req, socket, head) => {
  socket.once("error", () => socket.destroy());
  const upgrade: { socket?: HeartbeatSocket; releaseConnection?: () => void } = {};

  try {
    if (shuttingDown || !req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }

    const ip = getClientIp(req);
    const connectLimit = wsConnectLimiter.check(`ws:${ip}`);
    const activeForIp = activeWsByIp.get(ip) ?? 0;

    if (!isTrustedOrigin(req)) {
      metrics.inc("ws_connections_rejected_total");
      metrics.event("security", `Blocked WebSocket from untrusted origin ${req.headers.origin ?? "none"} (${ip})`);
      rejectUpgrade(socket, "403 Forbidden");
      return;
    }

    if (!connectLimit.allowed || activeForIp >= maxWsPerIp) {
      metrics.inc("ws_connections_rejected_total");
      metrics.inc("rate_limited_total");
      rejectUpgrade(socket, "429 Too Many Requests", 60);
      return;
    }

    const session = getSessionByToken(getSessionToken(req));
    if (!session) {
      metrics.inc("ws_connections_rejected_total");
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const heartbeatSocket = ws as HeartbeatSocket;
      upgrade.socket = heartbeatSocket;
      activeWsByIp.set(ip, (activeWsByIp.get(ip) ?? 0) + 1);
      let released = false;
      const releaseConnection = () => {
        if (released) {
          return;
        }
        released = true;
        const nextCount = Math.max(0, (activeWsByIp.get(ip) ?? 1) - 1);
        if (nextCount === 0) {
          activeWsByIp.delete(ip);
        } else {
          activeWsByIp.set(ip, nextCount);
        }
      };
      upgrade.releaseConnection = releaseConnection;
      // Install before hub initialization: later protocol errors escape the upgrade catch.
      let failed = false;
      heartbeatSocket.on("error", () => {
        if (failed) return;
        failed = true;
        releaseConnection();
        heartbeatSocket.terminate();
        metrics.event("error", "WebSocket transport failed");
      });
      heartbeatSocket.once("close", releaseConnection);
      heartbeatSocket.isAlive = true;
      heartbeatSocket.on("pong", () => {
        heartbeatSocket.isAlive = true;
      });

      if (ws.protocol !== WS_PROTOCOL) {
        ws.send(JSON.stringify({ type: "toast", tone: "warning", message: "Pixel Fleet was updated. Reload this page to reconnect." }));
        ws.close(4002, "Client update required");
        return;
      }
      hub.connect(ws, session.profile, { ip, sessionId: session.id, expiresAt: session.expiresAt });
    });
  } catch (error) {
    // Failed attempts remain rate-limited; only an acquired active slot is released.
    upgrade.releaseConnection?.();
    if (upgrade.socket) {
      upgrade.socket.terminate();
    } else {
      rejectUpgrade(socket, error instanceof InvalidCookieError ? "400 Bad Request" : "500 Internal Server Error");
    }
    metrics.inc("ws_connections_rejected_total");
    metrics.event("error", error instanceof InvalidCookieError ? "Invalid WebSocket cookie encoding" : "WebSocket upgrade failed");
  }
});

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; stopping Pixel Fleet.`);
  clearInterval(heartbeatInterval);
  stopRateLimitCleanup();

  const timeout = setTimeout(() => {
    console.error("Shutdown timed out.");
    process.exit(1);
  }, 10_000);
  timeout.unref();

  // Clear reconnect timers before closing sockets, so redeploys cannot cause forfeits.
  hub.resetRuntime(1012, "Server restarting");
  // Also close superseded sockets that are no longer tracked by the hub.
  for (const ws of wss.clients) {
    ws.close(1012, "Server restarting");
  }

  Promise.all([
    new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()))
  ]).then(() => {
    closeDatabase();
    clearTimeout(timeout);
    process.exit(0);
  }).catch((error) => {
    console.error("Shutdown failed:", error);
    process.exit(1);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(port, "0.0.0.0", () => {
  const address = server.address();
  const listeningPort = address && typeof address !== "string" ? address.port : port;
  console.log(`Pixel Fleet backend listening on http://0.0.0.0:${listeningPort}`);
});
