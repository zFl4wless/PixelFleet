import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpErrorContext } from "../apps/backend/src/metrics";

beforeEach(() => vi.resetModules());

describe("bounded HTTP diagnosis and response metrics (TD-07)", () => {
  it("counts completed responses exactly once, preserves totals and separates 4xx from 5xx", async () => {
    const { metrics } = await import("../apps/backend/src/metrics");
    for (const statusCode of [200, 400, 401, 403, 404, 413, 415, 429, 500, 503]) {
      const res = Object.assign(new EventEmitter(), { statusCode }) as unknown as ServerResponse;
      metrics.trackResponse(res); metrics.trackResponse(res);
      res.emit("finish"); res.emit("finish");
    }
    const closed = Object.assign(new EventEmitter(), { statusCode: 500 }) as unknown as ServerResponse;
    metrics.trackResponse(closed); closed.emit("close");
    expect(metrics.snapshot().counters).toMatchObject({ http_requests_total: 10, http_errors_total: 9, http_client_errors_total: 7, http_server_errors_total: 2 });
    expect(metrics.prometheus()).toContain("pixelfleet_http_server_errors_total 2");
    expect(metrics.prometheus()).not.toContain("{");
  });

  it("keeps only bounded allowlisted diagnosis and survives hostile thrown values", async () => {
    const { metrics } = await import("../apps/backend/src/metrics");
    const context: HttpErrorContext = { requestId: "server-id", method: "GET", route: "guest-login", stage: "handler", responseState: "unstarted" };
    const error = Object.assign(new Error("secret-body Authorization=secret-token"), { code: "ERR_SQLITE_ERROR", errcode: 19 });
    error.stack = "Error: secret-token\n    at call (/private/secret-path/apps/backend/src/db.ts:124:7)\n    at secret-user (/secret/body.ts:1:2)";
    metrics.httpError(context, error);
    expect((metrics.snapshot().recentEvents as unknown[])[0]).toMatchObject({ requestId: "server-id", diagnostic: {
      kind: "database", code: "ERR_SQLITE_ERROR", sqliteCode: 19, location: { component: "db", line: 124, column: 7 }
    } });
    const hostile = new Error("secret-user");
    Object.defineProperty(hostile, "code", { get() { throw new Error("secret-getter"); } });
    for (let index = 0; index < 60; index++) metrics.httpError({ ...context, method: "secret-method" }, index % 2 ? hostile : {
      body: "secret-body", cookie: "secret-cookie", path: "secret-path"
    });
    const snapshot = metrics.snapshot();
    expect(snapshot.recentEvents).toHaveLength(50);
    for (const event of snapshot.recentEvents as { method: string; diagnostic: unknown }[]) {
      expect(event.method).toBe("OTHER"); expect(event.diagnostic).toEqual({ kind: "unknown" });
    }
    expect(JSON.stringify(snapshot)).not.toContain("secret-");
  });
});
