import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { getSessionToken, InvalidCookieError, isAllowedOrigin } from "../apps/backend/src/http";

const originalFrontendOrigin = process.env.FRONTEND_ORIGIN;
const originalNodeEnv = process.env.NODE_ENV;

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
});
