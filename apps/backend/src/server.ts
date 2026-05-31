import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  createGuestAccount,
  deleteSession,
  getDatabaseStats,
  getProfileBySessionToken,
  resetDatabase,
  type ResetScope
} from "./db.js";
import {
  clearSessionCookie,
  getClientIp,
  getSessionToken,
  isTrustedOrigin,
  isSecureRequest,
  readJson,
  sendJson,
  sessionCookie,
  setCors,
  setSecurityHeaders
} from "./http.js";
import { GameHub } from "./game-hub.js";
import { metrics } from "./metrics.js";
import { FixedWindowRateLimiter, parseEnvInt } from "./rate-limit.js";

const port = Number(process.env.PORT ?? 3001);
const hub = new GameHub();
const frontendDistDir = process.env.FRONTEND_DIST_DIR ?? join(process.cwd(), "apps/frontend/dist");
const adminToken = process.env.ADMIN_TOKEN;
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
  return new URL(reqUrl ?? "/", "http://localhost").pathname;
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
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(metrics.prometheus(metricGauges()));
    return true;
  }

  if (req.method === "POST" && path === "/api/admin/reset") {
    const body = await readJson<{ scope?: ResetScope | "runtime" }>(req);
    const scope = body.scope ?? "runtime";
    const allowedScopes = new Set(["accounts", "all", "runtime", "sessions", "stats"]);

    if (!allowedScopes.has(scope)) {
      sendJson(res, 400, { error: "Invalid reset scope." });
      return true;
    }

    let database = getDatabaseStats();
    if (scope === "runtime") {
      hub.resetRuntime();
    } else {
      if (scope === "accounts" || scope === "all" || scope === "sessions") {
        hub.resetRuntime();
      }
      database = resetDatabase(scope);
    }

    metrics.inc("admin_actions_total");
    metrics.event("admin", `Admin reset executed from ${ip}: ${scope}`);
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
  const requestedPath = decodeURIComponent(url.pathname);

  if (requestedPath.startsWith("/api") || requestedPath.startsWith("/ws")) {
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

  const filePath = await stat(safeCandidate)
    .then((fileStat) => {
      if (fileStat.isFile()) {
        return safeCandidate;
      }

      if (fileStat.isDirectory()) {
        return join(safeCandidate, "index.html");
      }

      return join(frontendDistDir, "index.html");
    })
    .catch(() => join(frontendDistDir, "index.html"));

  try {
    await stat(filePath);
  } catch {
    return false;
  }

  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    ...(isNoIndexPath(requestedPath) ? { "X-Robots-Tag": "noindex, nofollow, noarchive" } : {})
  });
  createReadStream(filePath).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  metrics.trackResponse(res);
  setSecurityHeaders(res);
  setCors(req, res);
  const ip = getClientIp(req);
  const path = pathname(req.url);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (rateLimit(res, publicLimiter, `http:${ip}`)) {
      return;
    }

    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && !isTrustedOrigin(req)) {
      metrics.event("security", `Blocked untrusted origin from ${ip}: ${req.headers.origin ?? "none"}`);
      sendJson(res, 403, { error: "Untrusted origin." });
      return;
    }

    if (await handleAdminRoute(req, res, path, ip)) {
      return;
    }

    if (req.method === "GET" && path === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        name: "Pixel Fleet",
        uptimeSeconds: Math.round(process.uptime()),
        hub: hub.stats()
      });
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

      const body = await readJson<{ username?: string }>(req);
      const username = body.username ?? "";
      const { profile, sessionToken } = createGuestAccount(username);
      metrics.inc("guest_accounts_created_total");
      res.setHeader("Set-Cookie", sessionCookie(sessionToken, isSecureRequest(req)));
      sendJson(res, 201, { profile });
      return;
    }

    if (req.method === "POST" && path === "/api/logout") {
      deleteSession(getSessionToken(req));
      res.setHeader("Set-Cookie", clearSessionCookie(isSecureRequest(req)));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (await serveStatic(req.url, res)) {
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server error.";
    metrics.event("error", message);
    sendJson(res, 400, { error: message });
  }
});

const wss = new WebSocketServer({ noServer: true });
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

server.on("close", () => clearInterval(heartbeatInterval));

server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/ws")) {
    socket.destroy();
    return;
  }

  const ip = getClientIp(req);
  const connectLimit = wsConnectLimiter.check(`ws:${ip}`);
  const activeForIp = activeWsByIp.get(ip) ?? 0;

  if (!isTrustedOrigin(req)) {
    metrics.inc("ws_connections_rejected_total");
    metrics.event("security", `Blocked WebSocket from untrusted origin ${req.headers.origin ?? "none"} (${ip})`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (!connectLimit.allowed || activeForIp >= maxWsPerIp) {
    metrics.inc("ws_connections_rejected_total");
    metrics.inc("rate_limited_total");
    socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
    socket.destroy();
    return;
  }

  const profile = getProfileBySessionToken(getSessionToken(req));
  if (!profile) {
    metrics.inc("ws_connections_rejected_total");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const heartbeatSocket = ws as HeartbeatSocket;
    heartbeatSocket.isAlive = true;
    heartbeatSocket.on("pong", () => {
      heartbeatSocket.isAlive = true;
    });

    activeWsByIp.set(ip, activeForIp + 1);
    heartbeatSocket.on("close", () => {
      const nextCount = Math.max(0, (activeWsByIp.get(ip) ?? 1) - 1);
      if (nextCount === 0) {
        activeWsByIp.delete(ip);
      } else {
        activeWsByIp.set(ip, nextCount);
      }
    });

    hub.connect(ws, profile, { ip });
  });
});

server.listen(port, () => {
  console.log(`Pixel Fleet backend listening on http://localhost:${port}`);
});
