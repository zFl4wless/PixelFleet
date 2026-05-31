import { afterEach, describe, expect, it } from "vitest";
import { isAllowedOrigin } from "../apps/backend/src/http";

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
