import type { IncomingMessage, ServerResponse } from "node:http";

const SESSION_COOKIE_NAME = "pf_session";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const DEFAULT_MAX_JSON_BYTES = 16 * 1024;

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator === -1) {
          return [part, ""];
        }
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

export function getSessionToken(req: IncomingMessage): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] ?? null;
}

export function sessionCookie(token: string, secure: boolean): string {
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(
    token
  )}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; SameSite=Lax${secureFlag}`;
}

export function clearSessionCookie(secure: boolean): string {
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  return req.headers["x-forwarded-proto"] === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

export function getClientIp(req: IncomingMessage): string {
  const trustProxy = process.env.TRUST_PROXY !== "false";
  const forwardedFor = req.headers["x-forwarded-for"];

  if (trustProxy && typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return req.socket.remoteAddress ?? "unknown";
}

export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

export function isTrustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  const host = req.headers.host;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const inferredProto = forwardedProto === "https" || isSecureRequest(req) ? "https" : "http";
  const allowedOrigins = new Set([
    host ? `${inferredProto}://${host}` : "",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    process.env.FRONTEND_ORIGIN ?? ""
  ]);

  return allowedOrigins.has(origin);
}

export function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    req.headers.host ? `https://${req.headers.host}` : "",
    req.headers.host ? `http://${req.headers.host}` : "",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    process.env.FRONTEND_ORIGIN ?? ""
  ]);

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function readJson<T>(req: IncomingMessage, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<T> {
  const contentType = req.headers["content-type"];
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new Error("Expected application/json.");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {} as T;
  }

  return JSON.parse(raw) as T;
}
