import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { calculateMatchXp, type ServerMessage } from "@pixelfleet/shared";
import type { GameHub as Hub } from "../apps/backend/src/game-hub";
import { sessionCookie } from "../apps/backend/src/http";
import { metrics } from "../apps/backend/src/metrics";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const START = Date.parse("2026-10-12T12:00:00.123Z");
let directory: string;
let fixture: DatabaseSync;
let database: typeof import("../apps/backend/src/db");
let GameHub: typeof import("../apps/backend/src/game-hub").GameHub;
let hub: Hub;
const originalDatabasePath = process.env.DATABASE_PATH;

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: ServerMessage[] = [];
  closes: { code?: number; reason?: string }[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); }
  message(value: unknown) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  finishClose() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-session-expiry-"));
  process.env.DATABASE_PATH = join(directory, "fixture.sqlite");
  database = await import("../apps/backend/src/db");
  ({ GameHub } = await import("../apps/backend/src/game-hub"));
  fixture = new DatabaseSync(process.env.DATABASE_PATH);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  database.resetDatabase("all");
  hub = new GameHub();
});

afterEach(() => {
  hub.resetRuntime();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  fixture?.close();
  database?.closeDatabase();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  await rm(directory, { recursive: true, force: true });
});

function guest() {
  const { profile, sessionToken, expiresAt } = database.createGuestAccount("Expiry dummy");
  return { profile, token: sessionToken, id: createHash("sha256").update(sessionToken).digest("hex"), expiresAt };
}

function existingSession(remainingMs = 1500) {
  const player = guest();
  const createdAt = new Date(START - YEAR_MS + remainingMs).toISOString();
  fixture.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE token_hash = ?")
    .run(createdAt, createdAt, player.id);
  // Seed an established profile; match rewards can only be written as a whole completion.
  fixture.prepare("UPDATE users SET xp = ?, wins = 1, games_played = 1, hits = 3, shots_fired = 5, ships_sunk = 1 WHERE user_id = ?")
    .run(calculateMatchXp({ won: true, hits: 3, shotsFired: 5, shipsSunk: 1 }), player.profile.userId);
  return { ...player, profile: database.getProfile(player.profile.userId)!, createdAt, expiresAt: START + remainingMs };
}

function sessionRow(id: string) {
  return fixture.prepare("SELECT created_at, last_seen_at FROM sessions WHERE token_hash = ?").get(id) as {
    created_at: string; last_seen_at: string;
  };
}

function connect(player: ReturnType<typeof guest>) {
  const socket = new TestSocket();
  hub.connect(socket as unknown as WebSocket, player.profile, { ip: "127.0.0.1", sessionId: player.id, expiresAt: player.expiresAt });
  return socket;
}

describe("fixed guest session lifetime", () => {
  it("creates a 365-day deadline and a cookie with the same lifetime without rewriting creation time", () => {
    const player = guest();
    expect(player.expiresAt).toBe(START + YEAR_MS);
    expect(sessionRow(player.id)).toEqual({ created_at: new Date(START).toISOString(), last_seen_at: new Date(START).toISOString() });
    expect(sessionCookie(player.token, true, player.expiresAt)).toContain("Max-Age=31536000;");
    expect(database.getSessionByToken(player.token)).toEqual({ id: player.id, profile: player.profile, expiresAt: player.expiresAt });
  });

  it.each([-1, 0, 1])("checks an existing stored session at deadline offset %s ms, preserving account data", (offset) => {
    const player = existingSession();
    const before = sessionRow(player.id);
    vi.setSystemTime(player.expiresAt + offset);
    const session = database.getSessionByToken(player.token);
    const httpProfile = database.getProfileBySessionToken(player.token);
    if (offset < 0) {
      expect(session).toEqual({ id: player.id, profile: player.profile, expiresAt: player.expiresAt });
      expect(httpProfile).toEqual(player.profile);
      expect(sessionRow(player.id).last_seen_at).toBe(new Date(player.expiresAt - 1).toISOString());
    } else {
      expect(session).toBeNull();
      expect(httpProfile).toBeNull();
      expect(sessionRow(player.id).last_seen_at).toBe(before.last_seen_at);
    }
    expect(sessionRow(player.id).created_at).toBe(player.createdAt);
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
    expect(database.getDatabaseStats()).toMatchObject({ users: 1, sessions: 1, totalGamesPlayed: 1 });
  });

  it("does not renew the deadline through repeated profile lookups or last_seen_at updates", () => {
    const player = guest();
    for (const elapsed of [1, 100, 364]) {
      vi.setSystemTime(START + elapsed * 24 * 60 * 60 * 1000);
      expect(database.getSessionByToken(player.token)?.expiresAt).toBe(player.expiresAt);
      expect(sessionRow(player.id).created_at).toBe(new Date(START).toISOString());
      expect(sessionRow(player.id).last_seen_at).toBe(new Date(Date.now()).toISOString());
    }
    vi.setSystemTime(player.expiresAt);
    expect(database.getProfileBySessionToken(player.token)).toBeNull();
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
  });

  it("uses the session creation time rather than the older account creation time", () => {
    const player = guest();
    fixture.prepare("UPDATE users SET created_at = ? WHERE user_id = ?")
      .run(new Date(START - 2 * YEAR_MS).toISOString(), player.profile.userId);
    expect(database.getSessionByToken(player.token)?.expiresAt).toBe(START + YEAR_MS);
    expect(sessionRow(player.id).created_at).toBe(new Date(START).toISOString());
  });

  it("rejects an unreadable stored creation time without granting a fresh lifetime or resetting sessions", () => {
    const player = guest();
    fixture.prepare("UPDATE sessions SET created_at = ? WHERE token_hash = ?").run("invalid fixture timestamp", player.id);
    expect(database.getSessionByToken(player.token)).toBeNull();
    expect(sessionRow(player.id).created_at).toBe("invalid fixture timestamp");
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
    expect(database.getDatabaseStats()).toMatchObject({ users: 1, sessions: 1 });
  });

  it("limits cookie storage to whole seconds remaining in the absolute deadline", () => {
    const player = existingSession(2500);
    expect(sessionCookie(player.token, false, player.expiresAt)).toContain("Max-Age=2;");
    vi.setSystemTime(START + 1501);
    expect(sessionCookie(player.token, false, player.expiresAt)).toContain("Max-Age=0;");
    vi.setSystemTime(player.expiresAt);
    expect(sessionCookie(player.token, false, player.expiresAt)).toContain("Max-Age=0;");
    vi.setSystemTime(player.expiresAt + 1);
    expect(sessionCookie(player.token, false, player.expiresAt)).toContain("Max-Age=0;");
  });
});

describe("expiry of derived WebSocket permissions", () => {
  it("revokes a quiet new socket at exactly 365 days without overflowing Node's timer limit", () => {
    const player = guest();
    const socket = connect(player);
    socket.message({ type: "join_queue" });
    vi.advanceTimersByTime(YEAR_MS - 1);
    expect(socket.closes).toEqual([]);
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 1 });
    vi.advanceTimersByTime(1);
    expect(socket.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(hub.stats()).toMatchObject({ activeConnections: 0, queuedPlayers: 0 });
    vi.advanceTimersByTime(1);
    expect(socket.closes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
  });

  it("expires an existing session's quiet socket before any further message and rejects late actions", () => {
    const player = existingSession();
    const socket = connect(player);
    vi.advanceTimersByTime(1499);
    expect(socket.closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    const counters = metrics.snapshot().counters;
    socket.message({ type: "join_queue" });
    socket.message({ type: "leave_match" });
    socket.message({ type: "unknown" });
    expect(metrics.snapshot().counters).toEqual(counters);
    expect(hub.stats()).toMatchObject({ activeConnections: 0, queuedPlayers: 0 });
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
  });

  it("does not extend socket permissions when the session and socket are used near expiry", () => {
    const player = existingSession(10_000);
    const socket = connect(player);
    vi.advanceTimersByTime(9999);
    expect(database.getProfileBySessionToken(player.token)).toEqual(player.profile);
    socket.message({ type: "join_queue" });
    expect(hub.stats().queuedPlayers).toBe(1);
    expect(sessionRow(player.id).created_at).toBe(player.createdAt);
    expect(socket.closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(socket.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(database.getProfileBySessionToken(player.token)).toBeNull();
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
  });

  it("rejects messages at the deadline before decoding even when the expiry timer has not run", () => {
    const player = existingSession();
    const socket = connect(player);
    const decode = vi.fn(() => JSON.stringify({ type: "join_queue" }));
    const counters = metrics.snapshot().counters;
    vi.setSystemTime(player.expiresAt);
    socket.emit("message", { toString: decode });
    expect(decode).not.toHaveBeenCalled();
    expect(metrics.snapshot().counters).toEqual(counters);
    expect(socket.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(hub.stats().activeConnections).toBe(0);
  });

  it.each([0, 1])("rejects a new connection at deadline offset %s without replacing a valid independent connection", (offset) => {
    const old = existingSession();
    const token = `independent-expiry-dummy-${randomUUID()}`;
    const id = createHash("sha256").update(token).digest("hex");
    const timestamp = new Date(START).toISOString();
    fixture.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(id, old.profile.userId, timestamp, timestamp);
    const current = connect({ ...old, token, id, expiresAt: START + YEAR_MS });
    current.message({ type: "join_queue" });
    vi.setSystemTime(old.expiresAt + offset);
    const expired = connect(old);
    expect(expired.sent).toEqual([]);
    expect(expired.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(current.closes).toEqual([]);
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 1 });
    expect(database.getProfileBySessionToken(token)).toEqual(old.profile);
  });

  it("clears the expiry timer on disconnect without deleting account or session data", () => {
    const player = existingSession();
    const socket = connect(player);
    expect(vi.getTimerCount()).toBe(1);
    socket.finishClose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1501);
    expect(socket.closes).toEqual([]);
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
    expect(sessionRow(player.id).created_at).toBe(player.createdAt);
  });

  it.each(["error-first", "close-first"])("cleans up %s events once and ignores late errors after replacement", (order) => {
    const player = existingSession();
    const old = connect(player);
    old.message({ type: "join_queue" });
    expect(vi.getTimerCount()).toBe(1);
    if (order === "close-first") old.finishClose();
    expect(() => old.emit("error", new Error("Transport failure"))).not.toThrow();
    expect(() => old.emit("error", new Error("Repeated transport failure"))).not.toThrow();
    old.finishClose();
    old.finishClose();
    expect(hub.stats()).toMatchObject({ activeConnections: 0, queuedPlayers: 0 });
    expect(vi.getTimerCount()).toBe(0);
    const current = connect(player);
    old.emit("error", new Error("Late transport failure"));
    old.finishClose();
    expect(hub.stats().activeConnections).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(current.closes).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(current.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(old.closes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts one reconnect grace timer on error and preserves a recovered match through late error/close events", () => {
    const first = guest();
    const second = guest();
    const old = connect(first);
    const opponent = connect(second);
    old.message({ type: "join_queue" });
    opponent.message({ type: "join_queue" });
    expect(vi.getTimerCount()).toBe(2);
    expect(() => old.emit("error", new Error("Match transport failure"))).not.toThrow();
    const updates = opponent.sent.length;
    expect(vi.getTimerCount()).toBe(2); // One session expiry and one reconnect timer.
    old.emit("error", new Error("Repeated match transport failure"));
    old.finishClose();
    expect(opponent.sent).toHaveLength(updates);
    expect(vi.getTimerCount()).toBe(2);
    const current = connect(first);
    old.emit("error", new Error("Late old socket failure"));
    old.finishClose();
    expect(vi.getTimerCount()).toBe(2); // Both current session expiry timers only.
    vi.advanceTimersByTime(30_001);
    expect(hub.stats()).toMatchObject({ activeConnections: 2, placingMatches: 1, finishedMatches: 0 });
    current.emit("error", new Error("Final transport failure"));
    current.finishClose();
    current.emit("error", new Error("Late final transport failure"));
    vi.advanceTimersByTime(30_001);
    expect(hub.stats().finishedMatches).toBe(1);
    expect(database.getProfile(first.profile.userId)?.stats.gamesPlayed).toBe(1);
    expect(database.getProfile(second.profile.userId)?.stats.gamesPlayed).toBe(1);
    expect(vi.getTimerCount()).toBe(2); // Opponent session expiry and bounded result retention.
  });

  it("clears replacement timers and does not let a queued old callback revoke the current connection", () => {
    const player = existingSession();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const old = connect(player);
    const staleTimer = timers.mock.calls[0][0] as () => void;
    const current = connect(player);
    expect(old.closes).toEqual([{ code: 4001, reason: "New connection opened" }]);
    expect(vi.getTimerCount()).toBe(1);
    staleTimer();
    expect(current.closes).toEqual([]);
    old.finishClose();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(current.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(old.closes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a later independent session of the same account after the replaced session expires", () => {
    const player = existingSession();
    const old = connect(player);
    const token = `later-expiry-dummy-${randomUUID()}`;
    const id = createHash("sha256").update(token).digest("hex");
    const timestamp = new Date(START).toISOString();
    fixture.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(id, player.profile.userId, timestamp, timestamp);
    const current = connect({ ...player, token, id, expiresAt: START + YEAR_MS });
    vi.advanceTimersByTime(1501);
    expect(database.getProfileBySessionToken(player.token)).toBeNull();
    expect(database.getProfileBySessionToken(token)).toEqual(player.profile);
    expect(current.closes).toEqual([]);
    current.message({ type: "join_queue" });
    old.message({ type: "cancel_queue" });
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 1 });
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
  });

  it("clears runtime-reset timers and ignores their old callbacks after reconnect with the same session", () => {
    const player = existingSession();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const old = connect(player);
    const staleTimer = timers.mock.calls[0][0] as () => void;
    hub.resetRuntime();
    expect(vi.getTimerCount()).toBe(0);
    expect(old.closes).toEqual([{ code: 4009, reason: "Admin reset" }]);
    const current = connect(player);
    staleTimer();
    expect(current.closes).toEqual([]);
    expect(database.getProfileBySessionToken(player.token)).toEqual(player.profile);
    vi.advanceTimersByTime(1500);
    expect(current.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(old.closes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still revokes logout immediately and clears the expiry timer", () => {
    const player = existingSession();
    const socket = connect(player);
    hub.revokeSession(database.deleteSession(player.token)!);
    expect(socket.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1501);
    expect(socket.closes).toHaveLength(1);
    expect(database.getProfileBySessionToken(player.token)).toBeNull();
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
  });

  it("preserves the existing disconnect grace and account statistics when expiry interrupts a match", () => {
    const player = existingSession();
    const first = connect(player);
    const other = guest();
    const opponent = connect(other);
    first.message({ type: "join_queue" });
    opponent.message({ type: "join_queue" });
    vi.advanceTimersByTime(1500);
    const update = opponent.sent.filter((message) => message.type === "game_update").at(-1)!;
    expect(update.type).toBe("game_update");
    if (update.type !== "game_update") throw new Error("Expected disconnect view");
    expect(update.view.opponent.connected).toBe(false);
    expect(update.view.reconnectDeadline).toBe(Date.now() + 30_000);
    expect(database.getProfile(player.profile.userId)).toEqual(player.profile);
    vi.advanceTimersByTime(30_000);
    expect(hub.stats().finishedMatches).toBe(1);
    expect(database.getProfile(player.profile.userId)?.stats).toMatchObject({ wins: 1, losses: 1, gamesPlayed: 2 });
    expect(database.getProfile(other.profile.userId)?.stats.wins).toBe(1);
  });
});
