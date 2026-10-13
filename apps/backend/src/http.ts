import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { PublicInputError } from "./input-errors.js";

const SESSION_COOKIE_NAME = "pf_session";
const DEFAULT_MAX_JSON_BYTES = 16 * 1024;
const VITE_DEV_PORTS = new Set(["5173", "5174", "5175", "5176", "5177", "5178", "5179"]);

export class InvalidCookieError extends PublicInputError {
  constructor() {
    super("invalid_cookie");
    this.name = "InvalidCookieError";
  }
}

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
        try {
          return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
        } catch {
          // Reject the entire header rather than authenticating from partial results.
          throw new InvalidCookieError();
        }
      })
  );
}

export function getSessionToken(req: IncomingMessage): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] ?? null;
}

export function sessionCookie(token: string, secure: boolean, expiresAt: number): string {
  const secureFlag = secure ? "; Secure" : "";
  // Cookie precision is seconds: round down the remaining server-side lifetime.
  const maxAge = Number.isFinite(expiresAt) ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(
    token
  )}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureFlag}`;
}

export function clearSessionCookie(secure: boolean): string {
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`;
}

function trustsProxyHeaders(): boolean {
  return process.env.TRUST_PROXY !== "false";
}

export function isSecureRequest(req: IncomingMessage): boolean {
  return Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    (trustsProxyHeaders() && req.headers["x-forwarded-proto"] === "https");
}

export function getClientIp(req: IncomingMessage): string {
  if (trustsProxyHeaders()) {
    const forwardedFor = req.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
      return forwardedFor.split(",")[0]?.trim() || "unknown";
    }
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

function configuredFrontendOrigins(): string[] {
  return (process.env.FRONTEND_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }

  const addressType = isIP(normalized);
  if (addressType === 4) {
    return isPrivateIpv4(normalized);
  }
  if (addressType !== 6) {
    return false;
  }

  const firstHextet = Number.parseInt(normalized.split(":")[0], 16);
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" ||
    firstHextet === 0xfe80 || // Preserve the existing link-local allowance: fe80::/16.
    (firstHextet & 0xfe00) === 0xfc00; // Unique local: fc00::/7.
}

function isViteDevOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && VITE_DEV_PORTS.has(url.port) && isLocalOrPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string, host: string | undefined): boolean {
  const allowedOrigins = new Set([
    host ? `https://${host}` : "",
    host ? `http://${host}` : "",
    ...configuredFrontendOrigins()
  ]);

  return allowedOrigins.has(origin) || isViteDevOrigin(origin);
}

export function isTrustedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  return isAllowedOrigin(origin, req.headers.host);
}

export function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;

  if (origin && isAllowedOrigin(origin, req.headers.host)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-ID");
}

export function canRespond(res: ServerResponse): boolean {
  return !res.headersSent && !res.writableEnded && !res.destroyed;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (!canRespond(res)) return;
  // Serialize before committing headers so serialization failures can become a 500.
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function discardBody(req: IncomingMessage): void {
  // Consume late transport errors while draining an already rejected body.
  const ignore = () => {};
  req.on("error", ignore);
  req.once("close", () => req.off("error", ignore));
  req.resume();
}

export function requireJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new PublicInputError("invalid_body");
  return value as Record<string, unknown>;
}

export async function readJson(req: IncomingMessage, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (contentType?.split(";")[0].trim().toLowerCase() !== "application/json") {
    discardBody(req);
    throw new PublicInputError("unsupported_content_type");
  }
  if (Number(req.headers["content-length"]) > maxBytes) {
    discardBody(req);
    throw new PublicInputError("body_too_large");
  }

  // Unlike early return from an async iterator, rejecting here does not destroy
  // the request socket before its controlled 413 response can be delivered.
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      req.off("data", onData); req.off("end", onEnd); req.off("aborted", onAborted);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        settle(new PublicInputError("body_too_large"));
        req.resume();
      } else chunks.push(buffer);
    };
    const onEnd = () => settle();
    const onAborted = () => settle(new Error("Request aborted."));
    const onError = (error: Error) => settle(error);
    req.on("data", onData); req.once("end", onEnd); req.once("aborted", onAborted);
    // Retain this listener until close: an abort can emit error after aborted.
    req.on("error", onError);
    req.once("close", () => { req.off("error", onError); if (!settled) onAborted(); });
    if (req.destroyed && !req.complete) onAborted();
  });
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    // Classify only a parse failure at this boundary, never arbitrary SyntaxErrors.
    if (error instanceof SyntaxError) throw new PublicInputError("invalid_json");
    throw error;
  }
}
