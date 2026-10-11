import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clearSessionCookie, getClientIp, getSessionToken, InvalidCookieError, isAllowedOrigin, isSecureRequest, isTrustedOrigin, sessionCookie, setCors } from "../apps/backend/src/http";

const originalFrontendOrigin = process.env.FRONTEND_ORIGIN;
const originalNodeEnv = process.env.NODE_ENV;
const originalTrustProxy = process.env.TRUST_PROXY;

afterEach(() => {
  if (originalFrontendOrigin === undefined) {
    delete process.env.FRONTEND_ORIGIN;
  } else {
    process.env.FRONTEND_ORIGIN = originalFrontendOrigin;
  }

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
});

describe("proxy trust and cookie transport", () => {
  function request(headers: IncomingMessage["headers"] = {}, encrypted = false, remoteAddress: string | undefined = "192.0.2.10") {
    return { headers, socket: { encrypted, remoteAddress } } as unknown as IncomingMessage;
  }

  it("ignores forwarded client and transport information when proxy trust is disabled", () => {
    process.env.TRUST_PROXY = "false";
    for (const proto of ["https", "http", ["https"]]) {
      const req = request({ "x-forwarded-for": "203.0.113.7, 192.0.2.20", "x-forwarded-proto": proto, forwarded: "for=203.0.113.7;proto=https" });
      expect(getClientIp(req)).toBe("192.0.2.10");
      expect(isSecureRequest(req)).toBe(false);
    }
    const noPeer = request({ "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" });
    delete (noPeer.socket as { remoteAddress?: string }).remoteAddress;
    expect(getClientIp(noPeer)).toBe("unknown");
    expect(isSecureRequest(noPeer)).toBe(false);
  });

  it("keeps direct TLS secure regardless of proxy trust and a conflicting protocol header", () => {
    for (const trust of ["false", "true"]) {
      process.env.TRUST_PROXY = trust;
      expect(isSecureRequest(request({ "x-forwarded-proto": "http" }, true))).toBe(true);
      expect(isSecureRequest(request({}, true))).toBe(true);
    }
    process.env.TRUST_PROXY = "false";
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.7" }, true))).toBe("192.0.2.10");
  });

  it("keeps the documented first forwarded client and HTTPS protocol when proxy trust is enabled", () => {
    process.env.TRUST_PROXY = "true";
    const req = request({ "x-forwarded-for": " 203.0.113.7, 192.0.2.20", "x-forwarded-proto": "https" });
    expect(getClientIp(req)).toBe("203.0.113.7");
    expect(isSecureRequest(req)).toBe(true);
  });

  it("preserves the documented enabled default when TRUST_PROXY is unset", () => {
    delete process.env.TRUST_PROXY;
    const req = request({ "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" });
    expect(getClientIp(req)).toBe("203.0.113.7");
    expect(isSecureRequest(req)).toBe(true);
  });

  it("uses socket fallbacks and permits plain local HTTP without usable proxy headers", () => {
    for (const trust of ["false", "true"]) {
      process.env.TRUST_PROXY = trust;
      for (const headers of [{}, { "x-forwarded-for": "", "x-forwarded-proto": "http" }, { "x-forwarded-for": ["203.0.113.7"], "x-forwarded-proto": ["https"] }]) {
        expect(getClientIp(request(headers))).toBe("192.0.2.10");
        expect(isSecureRequest(request(headers))).toBe(false);
      }
    }
  });

  it("uses the same transport decision and cookie scope for session issue and deletion", () => {
    const cases = [
      { trust: "false", tls: false, proto: undefined, secure: false },
      { trust: "false", tls: false, proto: "https", secure: false },
      { trust: "false", tls: true, proto: "http", secure: true },
      { trust: "true", tls: false, proto: undefined, secure: false },
      { trust: "true", tls: false, proto: "http", secure: false },
      { trust: "true", tls: false, proto: "https", secure: true },
      { trust: "true", tls: true, proto: "http", secure: true }
    ];
    for (const fixture of cases) {
      process.env.TRUST_PROXY = fixture.trust;
      const secure = isSecureRequest(request({ "x-forwarded-proto": fixture.proto }, fixture.tls));
      expect(secure).toBe(fixture.secure);
      const issued = sessionCookie("dummy-session-token", secure).split("; ");
      const cleared = clearSessionCookie(secure).split("; ");
      expect(issued[0]).toBe("pf_session=dummy-session-token");
      expect(cleared[0]).toBe("pf_session=");
      expect(issued).toContain("Max-Age=31536000");
      expect(cleared).toContain("Max-Age=0");
      const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", ...(fixture.secure ? ["Secure"] : [])];
      expect(issued.slice(1).filter((part) => !part.startsWith("Max-Age="))).toEqual(attributes);
      expect(cleared.slice(1).filter((part) => !part.startsWith("Max-Age="))).toEqual(attributes);
    }
  });
});

describe("session cookies", () => {
  function sessionToken(cookie?: string) {
    return getSessionToken({ headers: { cookie } } as IncomingMessage);
  }

  it("keeps missing sessions distinct from valid decoded session cookies", () => {
    expect(sessionToken()).toBeNull();
    expect(sessionToken("theme=dark")).toBeNull();
    expect(sessionToken("pf_session=dummy-token")).toBe("dummy-token");
    expect(sessionToken("theme=dark; pf_session=dummy%2Dtoken; preference=a%3Db")).toBe("dummy-token");
    expect(sessionToken("  pf_session=dummy=token  ; theme=dark")).toBe("dummy=token");
  });

  it.each(["%", "%GG", "%C3"])("rejects invalid encoding %s instead of returning a session", (value) => {
    expect(() => sessionToken(`pf_session=${value}`)).toThrow(InvalidCookieError);
  });

  it("rejects a malformed header even when another cookie contains a valid session", () => {
    expect(() => sessionToken("pf_session=dummy-token; preference=%")).toThrow(InvalidCookieError);
    expect(() => sessionToken("preference=%; pf_session=dummy-token")).toThrow(InvalidCookieError);
  });
});

describe("origin checks", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "development";
    process.env.FRONTEND_ORIGIN = "";
  });

  it("allows either scheme for the request host", () => {
    expect(isAllowedOrigin("https://play.example.com", "play.example.com")).toBe(true);
    expect(isAllowedOrigin("http://play.example.com", "play.example.com")).toBe(true);
  });

  it("allows local Vite dev origins, including LAN addresses", () => {
    expect(isAllowedOrigin("http://localhost:5173", "localhost:3001")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5174", "localhost:3001")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173", "localhost:3001")).toBe(true);
    expect(isAllowedOrigin("http://192.168.178.114:5173", "localhost:3001")).toBe(true);
    expect(isAllowedOrigin("http://192.168.178.114:5174", "localhost:3001")).toBe(true);
  });

  it("rejects unrelated dev-like origins", () => {
    expect(isAllowedOrigin("http://203.0.113.20:5173", "localhost:3001")).toBe(false);
    expect(isAllowedOrigin("http://evil.test:5173", "localhost:3001")).toBe(false);
    expect(isAllowedOrigin("http://192.168.178.114:5180", "localhost:3001")).toBe(false);
  });

  it("rejects local Vite dev origins in production", () => {
    process.env.NODE_ENV = "production";

    expect(isAllowedOrigin("http://localhost:5173", "localhost:3001")).toBe(false);
    expect(isAllowedOrigin("http://localhost:5174", "localhost:3001")).toBe(false);
    expect(isAllowedOrigin("http://192.168.178.114:5174", "localhost:3001")).toBe(false);
  });

  it("allows comma-separated configured frontend origins", () => {
    process.env.FRONTEND_ORIGIN = "https://frontend.example.com, https://preview.example.com";

    expect(isAllowedOrigin("https://frontend.example.com", "api.example.com")).toBe(true);
    expect(isAllowedOrigin("https://preview.example.com", "api.example.com")).toBe(true);
  });

  it("does not treat DNS names with IPv6-like prefixes as private IP addresses", () => {
    for (const hostname of ["fc.example", "fd.example", "FC-assets.example", "fd00", "fc00.local", "fd12.example", "fe80.example", "localhost.example"]) {
      expect(isAllowedOrigin(`http://${hostname}:5173`, "localhost:3001"), hostname).toBe(false);
    }
    for (const hostname of ["localhost", "app.localhost", "FC.localhost"]) {
      expect(isAllowedOrigin(`http://${hostname}:5173`, "localhost:3001"), hostname).toBe(true);
    }
  });

  it("keeps the local IPv4 ranges and recognizes real local IPv6 addresses", () => {
    for (const hostname of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.255.255",
      "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255", "169.254.0.1", "169.254.255.255",
      "[::1]", "[0:0:0:0:0:0:0:1]", "[fc00::1]", "[FC00:0:0:0:0:0:0:1]", "[fd12:3456:789a::1]",
      "[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]", "[fe80::1]", "[fe80:ffff:ffff:ffff:ffff:ffff:ffff:ffff]"
    ]) {
      expect(isAllowedOrigin(`http://${hostname}:5173`, "localhost:3001"), hostname).toBe(true);
    }
  });

  it("rejects other IP ranges and invalid address syntax", () => {
    for (const hostname of [
      "9.255.255.255", "11.0.0.0", "126.255.255.255", "128.0.0.0", "172.15.255.255", "172.32.0.0",
      "192.167.255.255", "192.169.0.0", "169.253.255.255", "169.255.0.0", "203.0.113.20",
      "[::]", "[::2]", "[2001:db8::1]", "[fc::1]", "[fd::1]", "[fc0::1]", "[fd0::1]", "[fbff::1]", "[fe00::1]",
      "[fe7f::1]", "[fe81::1]", "[fe90::1]", "[febf::1]", "[fec0::1]", "[::ffff:127.0.0.1]",
      "10.0.0.256", "192.168.1.-1", "10.0.0.1.example", "[fdgg::1]", "[fc00:::1]", "[fe80::1::2]", "[fd00]", "[fd00::1"
    ]) {
      expect(isAllowedOrigin(`http://${hostname}:5173`, "localhost:3001"), hostname).toBe(false);
    }
  });

  it("limits automatic development origins to HTTP(S) and the existing Vite ports", () => {
    for (const hostname of ["localhost", "10.0.0.1", "[fd00::1]"]) {
      for (const scheme of ["http", "https"]) {
        for (let port = 5173; port <= 5179; port += 1) {
          expect(isAllowedOrigin(`${scheme}://${hostname}:${port}`, "localhost:3001")).toBe(true);
        }
        for (const port of ["", ":80", ":443", ":3001", ":5172", ":5180", ":65536"]) {
          expect(isAllowedOrigin(`${scheme}://${hostname}${port}`, "backend.example:3001")).toBe(false);
        }
      }
      for (const scheme of ["ws", "wss", "ftp"]) {
        expect(isAllowedOrigin(`${scheme}://${hostname}:5173`, "localhost:3001")).toBe(false);
      }
    }
  });

  it("disables all automatic development categories in production while retaining explicit origins", () => {
    process.env.NODE_ENV = "production";
    for (const hostname of ["localhost", "app.localhost", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "[::1]", "[fc00::1]", "[fd00::1]", "[fe80::1]"]) {
      for (const scheme of ["http", "https"]) {
        for (let port = 5173; port <= 5179; port += 1) {
          expect(isAllowedOrigin(`${scheme}://${hostname}:${port}`, "backend.example:3001")).toBe(false);
        }
      }
    }
    process.env.FRONTEND_ORIGIN = "https://fc-assets.example:5173, http://[fd00::1]:5173";
    expect(isAllowedOrigin("https://fc-assets.example:5173", "backend.example:3001")).toBe(true);
    expect(isAllowedOrigin("http://fc-assets.example:5173", "backend.example:3001")).toBe(false);
    expect(isAllowedOrigin("http://[fd00::1]:5173", "backend.example:3001")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", "localhost:5173")).toBe(true);
  });

  it("uses the same origin decision for HTTP trust, CORS and the WebSocket trust predicate", () => {
    const origins: [string, boolean][] = [
      ["http://localhost:5173", true], ["https://app.localhost:5179", true],
      ["http://192.168.1.2:5174", true], ["http://[::1]:5173", true],
      ["http://[fd00::1]:5173", true], ["http://[fe80::1]:5173", true],
      ["http://fc.example:5173", false], ["http://fd.example:5173", false],
      ["http://[fdgg::1]:5173", false], ["http://[2001:db8::1]:5173", false],
      ["http://localhost:5180", false], ["https://configured.example", false]
    ];
    for (const mode of ["development", "production"]) {
      process.env.NODE_ENV = mode;
      process.env.FRONTEND_ORIGIN = "https://configured.example";
      for (const [origin, devAllowed] of origins) {
        const expected = origin === "https://configured.example" || (mode === "development" && devAllowed);
        const request = { headers: { origin, host: "backend.example:3001" } } as IncomingMessage;
        const headers = new Map<string, string>();
        const response = { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as ServerResponse;
        expect(isAllowedOrigin(origin, request.headers.host), `${mode}: ${origin}`).toBe(expected);
        expect(isTrustedOrigin(request), `${mode}: ${origin}`).toBe(expected);
        setCors(request, response);
        expect(headers.get("Access-Control-Allow-Origin")).toBe(expected ? origin : undefined);
        expect(headers.get("Access-Control-Allow-Credentials")).toBe(expected ? "true" : undefined);
        expect(headers.get("Vary")).toBe(expected ? "Origin" : undefined);
      }
    }
  });
});
