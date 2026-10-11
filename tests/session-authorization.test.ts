import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { PlayerProfile, ServerMessage } from "@pixelfleet/shared";
import type { GameHub as Hub } from "../apps/backend/src/game-hub";
import { metrics } from "../apps/backend/src/metrics";

// Closing is deliberately delayed: authorization must not depend on transport completion.
class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: ServerMessage[] = [];
  closes: { code?: number; reason?: string }[] = [];
  onCloseRequested?: () => void;

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.onCloseRequested?.();
  }

  finishClose() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  message(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }

  invalid() {
    this.emit("message", Buffer.from("not-json"));
  }
}

let directory: string;
let database: typeof import("../apps/backend/src/db");
let GameHub: typeof import("../apps/backend/src/game-hub").GameHub;
let hub: Hub;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-session-auth-"));
  process.env.DATABASE_PATH = join(directory, "fixture.sqlite");
  database = await import("../apps/backend/src/db");
  ({ GameHub } = await import("../apps/backend/src/game-hub"));
});

beforeEach(() => {
  database.resetDatabase("all");
  hub = new GameHub();
});

afterEach(() => {
  hub.resetRuntime();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  database?.closeDatabase();
  if (originalDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = originalDatabasePath;
  }
  await rm(directory, { recursive: true, force: true });
});

function guest(username = "Dummy guest") {
  const { profile, sessionToken } = database.createGuestAccount(username);
  return { profile, token: sessionToken, session: database.getSessionByToken(sessionToken)! };
}

function independentSession(profile: PlayerProfile) {
  const token = `dummy-session-${randomUUID()}`;
  const fixture = new DatabaseSync(join(directory, "fixture.sqlite"));
  try {
    const timestamp = new Date().toISOString();
    fixture.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(createHash("sha256").update(token).digest("hex"), profile.userId, timestamp, timestamp);
  } finally {
    fixture.close();
  }
  return { token, session: database.getSessionByToken(token)! };
}

function connect(profile: PlayerProfile, sessionId: string, socket = new TestSocket()) {
  hub.connect(socket as unknown as WebSocket, profile, { ip: "127.0.0.1", sessionId });
  return socket;
}

function revoke(token: string) {
  const id = database.deleteSession(token);
  if (id) hub.revokeSession(id);
}

function lastView(socket: TestSocket) {
  const update = socket.sent.filter((message) => message.type === "game_update").at(-1);
  if (!update || update.type !== "game_update") throw new Error("Expected a game update.");
  return update.view;
}

describe("session-bound WebSocket authorization", () => {
  it("keeps the internal session reference out of public profile messages", () => {
    const player = guest();
    const socket = connect(player.profile, player.session.id);
    expect(player.session.id).not.toBe(player.token);
    expect(socket.sent).toEqual([{ type: "profile", profile: player.profile }]);
    expect(JSON.stringify(socket.sent)).not.toContain(player.token);
    expect(JSON.stringify(socket.sent)).not.toContain(player.session.id);
  });

  it("revokes only the deleted session before transport close, without processing its late messages", () => {
    const first = guest("First dummy");
    const other = guest("Other dummy");
    const old = connect(first.profile, first.session.id);
    const current = connect(other.profile, other.session.id);
    old.message({ type: "join_queue" });
    expect(hub.stats().queuedPlayers).toBe(1);
    revoke(first.token);
    expect(old.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
    expect(database.getSessionByToken(first.token)).toBeNull();
    expect(database.getSessionByToken(other.token)?.profile.userId).toBe(other.profile.userId);
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 0 });
    const counters = metrics.snapshot().counters;
    const messages = [...current.sent];
    old.message({ type: "join_queue" });
    old.message({ type: "leave_match" });
    for (let i = 0; i < 8; i += 1) old.invalid();
    expect(metrics.snapshot().counters).toEqual(counters);
    expect(current.sent).toEqual(messages);
    expect(current.closes).toEqual([]);
    old.finishClose();
    current.message({ type: "join_queue" });
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 1 });
  });

  it("preserves an independent session and replacement socket of the same account", () => {
    const player = guest();
    const old = connect(player.profile, player.session.id);
    const independent = independentSession(player.profile);
    const current = connect(player.profile, independent.session.id);
    revoke(player.token);
    expect(database.getSessionByToken(player.token)).toBeNull();
    expect(database.getSessionByToken(independent.token)?.profile.userId).toBe(player.profile.userId);
    current.message({ type: "join_queue" });
    old.message({ type: "cancel_queue" });
    for (let i = 0; i < 8; i += 1) old.invalid();
    old.finishClose();
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 1 });
    expect(current.closes).toEqual([]);
    revoke(independent.token);
    expect(hub.stats()).toMatchObject({ activeConnections: 0, queuedPlayers: 0 });
    expect(current.closes).toEqual([{ code: 4003, reason: "Session revoked" }]);
  });

  it("preserves the logout reconnect window and normal disconnect forfeit", () => {
    vi.useFakeTimers();
    const first = guest("Reconnecting dummy");
    const second = guest("Opponent dummy");
    const old = connect(first.profile, first.session.id);
    const opponent = connect(second.profile, second.session.id);
    old.message({ type: "join_queue" });
    opponent.message({ type: "join_queue" });
    revoke(first.token);
    expect(lastView(opponent).opponent.connected).toBe(false);
    expect(lastView(opponent).reconnectDeadline).toBe(Date.now() + 30_000);
    const offlineView = lastView(opponent);
    old.message({ type: "leave_match" });
    expect(lastView(opponent)).toEqual(offlineView);
    const independent = independentSession(first.profile);
    const reconnected = connect(first.profile, independent.session.id);
    old.finishClose();
    expect(lastView(opponent).opponent.connected).toBe(true);
    vi.advanceTimersByTime(30_001);
    expect(hub.stats().finishedMatches).toBe(0);
    reconnected.finishClose();
    vi.advanceTimersByTime(30_001);
    expect(hub.stats().finishedMatches).toBe(1);
    expect(database.getProfile(second.profile.userId)?.stats.wins).toBe(1);
  });

  it("ignores messages and close callbacks during replacement without removing the queue entry", () => {
    const player = guest();
    const old = connect(player.profile, player.session.id);
    old.message({ type: "join_queue" });
    old.onCloseRequested = () => {
      old.message({ type: "cancel_queue" });
      old.invalid();
      old.finishClose();
    };
    const current = connect(player.profile, player.session.id);
    expect(old.closes[0].code).toBe(4001);
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 1 });
    expect(current.sent.some((message) => message.type === "queue_status" && message.queued)).toBe(true);
    expect(current.sent.some((message) => message.type === "error")).toBe(false);
    expect(current.closes).toEqual([]);
  });

  it("does not let replaced connections consume the current message or queue quota", () => {
    vi.stubEnv("WS_MESSAGES_PER_10S", "2");
    vi.stubEnv("QUEUE_ACTIONS_PER_MINUTE", "2");
    hub = new GameHub();
    const player = guest();
    const old = connect(player.profile, player.session.id);
    const current = connect(player.profile, player.session.id);
    for (let i = 0; i < 3; i += 1) {
      old.message({ type: "join_queue" });
      old.message({ type: "cancel_queue" });
      old.invalid();
    }
    current.message({ type: "join_queue" });
    expect(hub.stats().queuedPlayers).toBe(1);
    current.message({ type: "cancel_queue" });
    expect(hub.stats().queuedPlayers).toBe(0);
    expect(current.sent.some((message) => message.type === "error")).toBe(false);
    expect(current.closes).toEqual([]);
  });

  it("preserves a match when a replaced connection leaves or closes late", () => {
    vi.useFakeTimers();
    const first = guest("Replacement first");
    const second = guest("Replacement opponent");
    const old = connect(first.profile, first.session.id);
    const opponent = connect(second.profile, second.session.id);
    old.message({ type: "join_queue" });
    opponent.message({ type: "join_queue" });
    const current = connect(first.profile, first.session.id);
    const view = lastView(opponent);
    old.message({ type: "leave_match" });
    old.finishClose();
    vi.advanceTimersByTime(30_001);
    expect(lastView(opponent)).toEqual(view);
    expect(lastView(current).you.connected).toBe(true);
    expect(hub.stats()).toMatchObject({ activeConnections: 2, placingMatches: 1, finishedMatches: 0 });
    expect(database.getProfile(second.profile.userId)?.stats.gamesPlayed).toBe(0);
    current.message({ type: "leave_match" });
    expect(hub.stats().finishedMatches).toBe(1);
    expect(database.getProfile(second.profile.userId)?.stats.wins).toBe(1);
  });

  it("charges only current invalid messages to the error budget and closes that connection", () => {
    const player = guest();
    const old = connect(player.profile, player.session.id);
    const current = connect(player.profile, player.session.id);
    for (let i = 0; i < 8; i += 1) old.invalid();
    old.emit("message", Buffer.alloc(4097));
    expect(current.sent).toEqual([{ type: "profile", profile: player.profile }]);
    for (let i = 0; i < 7; i += 1) current.invalid();
    expect(current.closes).toEqual([]);
    current.invalid();
    expect(current.closes).toEqual([{ code: 4008, reason: "Too many invalid actions" }]);
  });

  it("ignores a current socket that is not open before decoding or charging a message", () => {
    const player = guest();
    const socket = connect(player.profile, player.session.id);
    const decode = vi.fn(() => JSON.stringify({ type: "join_queue" }));
    const counters = metrics.snapshot().counters;
    for (const state of [WebSocket.CLOSING, WebSocket.CLOSED]) {
      socket.readyState = state;
      socket.emit("message", { toString: decode });
    }
    expect(decode).not.toHaveBeenCalled();
    expect(metrics.snapshot().counters).toEqual(counters);
    socket.readyState = WebSocket.OPEN;
    socket.message({ type: "join_queue" });
    expect(hub.stats().queuedPlayers).toBe(1);
  });

  it("invalidates reset generations before close and cancels their reconnect timers", () => {
    vi.useFakeTimers();
    const first = guest("Reset first");
    const second = guest("Reset second");
    const disconnected = connect(first.profile, first.session.id);
    const old = connect(second.profile, second.session.id);
    disconnected.message({ type: "join_queue" });
    old.message({ type: "join_queue" });
    for (let i = 0; i < 7; i += 1) old.invalid();
    disconnected.finishClose();
    old.onCloseRequested = () => old.message({ type: "join_queue" });
    expect(hub.resetRuntime()).toMatchObject({ activeConnections: 0, queuedPlayers: 0, matches: 0 });
    expect(old.closes[0].code).toBe(4009);
    expect(database.getSessionByToken(second.token)).not.toBeNull();
    const current = connect(second.profile, second.session.id);
    current.message({ type: "join_queue" });
    const counters = metrics.snapshot().counters;
    old.message({ type: "cancel_queue" });
    old.message({ type: "leave_match" });
    for (let i = 0; i < 8; i += 1) old.invalid();
    old.finishClose();
    vi.advanceTimersByTime(30_001);
    expect(metrics.snapshot().counters).toEqual(counters);
    expect(hub.stats()).toMatchObject({ activeConnections: 1, queuedPlayers: 1, matches: 0 });
    expect(database.getProfile(first.profile.userId)?.stats.gamesPlayed).toBe(0);
    expect(database.getProfile(second.profile.userId)?.stats.gamesPlayed).toBe(0);
    expect(current.closes).toEqual([]);
    for (let i = 0; i < 7; i += 1) current.invalid();
    expect(current.closes).toEqual([]);
    current.invalid();
    expect(current.closes).toEqual([{ code: 4008, reason: "Too many invalid actions" }]);
  });
});
