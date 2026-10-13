import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { validateFleet, type ClientMessage, type ServerMessage, type ShipPlacement } from "@pixelfleet/shared";
import type { GameHub } from "../apps/backend/src/game-hub";
import type { MatchCompletion } from "../apps/backend/src/db";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: ServerMessage[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  message(message: ClientMessage) { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

let directory: string;
let database: typeof import("../apps/backend/src/db");
let fixture: DatabaseSync;
let hub: GameHub;
let metrics: typeof import("../apps/backend/src/metrics").metrics;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-td05-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "fixture.sqlite"));
  database = await import("../apps/backend/src/db");
  fixture = new DatabaseSync(process.env.DATABASE_PATH!);
  const module = await import("../apps/backend/src/game-hub");
  hub = new module.GameHub();
  ({ metrics } = await import("../apps/backend/src/metrics"));
});

afterEach(async () => {
  hub?.resetRuntime();
  fixture?.close();
  database?.closeDatabase();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function guest() {
  const player = database.createGuestAccount("Persistence dummy");
  const session = database.getSessionByToken(player.sessionToken)!;
  return { ...player, session };
}

function connect(player: ReturnType<typeof guest>) {
  const socket = new Socket();
  hub.connect(socket as unknown as WebSocket, database.getProfile(player.profile.userId)!, {
    ip: "127.0.0.1", sessionId: player.session.id, expiresAt: player.expiresAt
  });
  return socket;
}

function view(socket: Socket) {
  const views = socket.sent.flatMap((item) => {
    if (item.type === "session_snapshot") return item.state.kind === "match" ? [item.state.view] : [];
    return item.type === "game_update" || item.type === "match_finished" ? [item.view] : [];
  });
  const latest = views.at(-1);
  if (!latest) throw new Error("Expected a match view.");
  return latest;
}

function pair() {
  const players = [guest(), guest()] as const;
  const sockets = players.map(connect);
  for (const socket of sockets) socket.message({ type: "join_queue" });
  return { players, sockets, matchId: view(sockets[0]).matchId };
}

function failSecondUpdate() {
  fixture.exec(`CREATE TRIGGER fail_second_update BEFORE UPDATE OF games_played ON users
    WHEN (SELECT SUM(games_played) FROM users) > 0
    BEGIN SELECT RAISE(ABORT, 'injected second update failure'); END;`);
}

function receiptCount() {
  return (fixture.prepare("SELECT COUNT(*) AS count FROM match_completions").get() as { count: number }).count;
}

function decision(players = [guest(), guest()]): MatchCompletion {
  return { matchId: "durable-match", winnerId: players[0].profile.userId, reason: "ships_sunk",
    players: players.map((p) => ({ userId: p.profile.userId, shotsFired: 20, hits: 14, shipsSunk: 5 })) };
}

function profiles(input: MatchCompletion) { return input.players.map((p) => database.getProfile(p.userId)); }

const fleet: ShipPlacement[] = [
  { shipId: "battleship", x: 0, y: 0, orientation: "horizontal" },
  { shipId: "cruiser", x: 0, y: 2, orientation: "horizontal" },
  { shipId: "destroyer-a", x: 0, y: 4, orientation: "horizontal" },
  { shipId: "destroyer-b", x: 0, y: 6, orientation: "horizontal" },
  { shipId: "submarine", x: 0, y: 8, orientation: "horizontal" }
];

function completionRow() {
  return fixture.prepare("SELECT * FROM match_completions").get() as { decision_json: string; completed_at: string };
}

describe("atomic match persistence (TD-05)", () => {
  it("rolls back both player updates and publishes no completion if the second update fails", () => {
    const { players, sockets } = pair();
    failSecondUpdate();
    sockets.forEach((socket) => { socket.sent = []; });
    sockets[0].message({ type: "leave_match" });
    expect(players.map((p) => database.getProfile(p.profile.userId)!.stats.gamesPlayed)).toEqual([0, 0]);
    expect(players.map((p) => database.getProfile(p.profile.userId)!.xp)).toEqual([0, 0]);
    expect(hub.stats().finishedMatches).toBe(0);
    expect(sockets.flatMap((socket) => socket.sent).filter((m) => m.type === "profile" || m.type === "match_finished")).toEqual([]);
    expect(metrics.snapshot().counters).toMatchObject({ matches_finished_total: 0 });
    expect(receiptCount()).toBe(0);
  });

  it("contains persistence failures from the disconnect timeout", () => {
    const { players, sockets } = pair();
    failSecondUpdate();
    sockets[0].close();
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(players.map((p) => database.getProfile(p.profile.userId)!.stats.gamesPlayed)).toEqual([0, 0]);
    expect(hub.stats().finishedMatches).toBe(0);
  });

  it("rolls back the account if session creation fails", () => {
    fixture.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected session failure'); END;");
    expect(() => guest()).toThrow(/injected session failure/);
    expect(database.getDatabaseStats()).toMatchObject({ users: 0, sessions: 0, totalXp: 0 });
    fixture.exec("DROP TRIGGER fail_session");
    const created = guest();
    expect(database.getSessionByToken(created.sessionToken)?.profile).toEqual(created.profile);
    expect(database.getDatabaseStats()).toMatchObject({ users: 1, sessions: 1 });
  });
});

describe("durable completion receipts (TD-05)", () => {
  it("handles SQLite rolling back the transaction itself and permits a subsequent commit", () => {
    const input = decision();
    const before = profiles(input);
    fixture.exec(`CREATE TRIGGER rollback_update BEFORE UPDATE OF games_played ON users
      WHEN (SELECT SUM(games_played) FROM users) > 0
      BEGIN SELECT RAISE(ROLLBACK, 'injected SQLite rollback'); END;`);
    expect(() => database.completeMatch(input)).toThrow(/injected SQLite rollback/);
    expect(profiles(input)).toEqual(before);
    expect(receiptCount()).toBe(0);
    fixture.exec("DROP TRIGGER rollback_update");
    expect(database.completeMatch(input).applied).toBe(true);
  });

  it("rolls back the receipt and all rewards, retries successfully, and remains idempotent after reopening", async () => {
    const input = decision();
    const before = profiles(input);
    failSecondUpdate();
    expect(() => database.completeMatch(input)).toThrow(/injected second update failure/);
    expect(profiles(input)).toEqual(before);
    expect(receiptCount()).toBe(0);
    fixture.exec("DROP TRIGGER fail_second_update");
    const committed = database.completeMatch(input);
    expect(committed.applied).toBe(true);
    expect(committed.updates.every((u) => u.profile!.stats.gamesPlayed === 1 && u.xpEarned > 0)).toBe(true);
    expect(receiptCount()).toBe(1);
    const after = profiles(input);
    expect(database.completeMatch({ ...input, players: [...input.players].reverse() }).applied).toBe(false);
    expect(profiles(input)).toEqual(after);
    database.closeDatabase();
    vi.resetModules();
    database = await import("../apps/backend/src/db");
    expect(database.completeMatch(input).applied).toBe(false);
    expect(profiles(input)).toEqual(after);
    expect(receiptCount()).toBe(1);
  });

  it.each(["winner", "reason", "stats", "participant"])("rejects conflicting %s data for a committed ID without writes", (field) => {
    const input = decision();
    database.completeMatch(input);
    const before = profiles(input);
    const changed = structuredClone(input);
    if (field === "winner") changed.winnerId = input.players[1].userId;
    if (field === "reason") changed.reason = "forfeit";
    if (field === "stats") changed.players[0].shotsFired++;
    if (field === "participant") changed.players[1].userId = guest().profile.userId;
    expect(() => database.completeMatch(changed)).toThrow(database.MatchCompletionConflict);
    expect(profiles(input)).toEqual(before);
    expect(receiptCount()).toBe(1);
  });

  it("rolls back a missing participant and rejects malformed decisions before writes", () => {
    const input = decision();
    const before = profiles(input);
    expect(() => database.completeMatch({ ...input, players: [input.players[0], { ...input.players[1], userId: "missing" }] })).toThrow(/User not found/);
    for (const invalid of [
      { ...input, winnerId: "missing" },
      { ...input, players: [input.players[0], input.players[0]] },
      { ...input, players: input.players.map((p) => ({ ...p, hits: -1 })) }
    ]) expect(() => database.completeMatch(invalid)).toThrow(/Invalid match/);
    expect(profiles(input)).toEqual(before);
    expect(receiptCount()).toBe(0);
  });

  it.each(["stats", "accounts", "all", "sessions"] as const)("preserves idempotency through the %s reset", (scope) => {
    const input = decision();
    database.completeMatch(input);
    database.resetDatabase(scope);
    const resetProfiles = profiles(input);
    const again = database.completeMatch(input);
    expect(again.applied).toBe(false);
    expect(profiles(input)).toEqual(resetProfiles);
    expect(receiptCount()).toBe(1);
    if (scope === "stats") expect(again.updates.every((u) => u.profile!.xp === 0 && u.profile!.stats.gamesPlayed === 0)).toBe(true);
    if (scope === "accounts" || scope === "all") expect(again.updates.every((u) => u.profile === null)).toBe(true);
  });
});

describe("completion failure lifecycle (TD-05)", () => {
  it("stops on a conflicting durable decision without retries or false completion messages", () => {
    const { players, sockets, matchId } = pair();
    const input: MatchCompletion = { matchId, winnerId: players[0].profile.userId, reason: "forfeit",
      players: players.map((p) => ({ userId: p.profile.userId, shotsFired: 0, hits: 0, shipsSunk: 0 })) };
    database.completeMatch(input);
    const before = profiles(input);
    sockets.forEach((s) => { s.sent = []; });
    sockets[0].message({ type: "leave_match" }); // Would award the other player.
    expect(view(sockets[0]).message).toContain("could not be saved");
    expect(vi.getTimerCount()).toBe(2); // Sessions only, no retry on a data conflict.
    vi.advanceTimersByTime(5000);
    expect(profiles(input)).toEqual(before);
    expect(receiptCount()).toBe(1);
    expect(sockets.flatMap((s) => s.sent).some((m) => m.type === "match_finished" || m.type === "profile")).toBe(false);
    expect(metrics.snapshot().counters).toMatchObject({ matches_finished_total: 0 });
  });

  it("freezes a failed last shot and its winner, then publishes once and starts retention at commit", () => {
    vi.stubEnv("FINISHED_MATCH_RETENTION_MS", "100");
    // Recreate with the configured retention; no connections exist yet.
    hub = new (hub.constructor as new () => GameHub)();
    const { players, sockets, matchId } = pair();
    sockets.forEach((s) => s.message({ type: "place_ships", placements: fleet }));
    const validation = validateFleet(fleet);
    if (!validation.valid) throw new Error(validation.error);
    const cells = validation.ships.flatMap((ship) => ship.cells);
    const shots = [0, 0];
    const turn = () => view(sockets[0]).currentTurnUserId === players[0].profile.userId ? 0 : 1;
    for (let i = 0; i < cells.length * 2 - 2; i++) {
      const index = turn();
      sockets[index].message({ type: "fire", ...cells[shots[index]++] });
    }
    const winner = turn();
    failSecondUpdate();
    sockets.forEach((s) => { s.sent = []; });
    sockets[winner].message({ type: "fire", ...cells[shots[winner]++] });
    const frozen = view(sockets[winner]);
    expect(frozen).toMatchObject({ matchId, phase: "saving", currentTurnUserId: null });
    expect(frozen.result).toBeUndefined();
    expect(frozen.message).toContain("Saving match result");
    expect(sockets.flatMap((s) => s.sent).some((m) => m.type === "match_finished" || m.type === "profile")).toBe(false);
    expect(receiptCount()).toBe(0);
    expect(metrics.snapshot().counters).toMatchObject({ matches_finished_total: 0 });
    for (const socket of sockets) {
      socket.message({ type: "leave_match" });
      socket.message({ type: "fire", x: 9, y: 9 });
      socket.message({ type: "join_queue" });
    }
    expect(view(sockets[winner])).toEqual(frozen);
    sockets[winner].close();
    sockets[winner] = connect(players[winner]);
    expect(view(sockets[winner])).toMatchObject({ currentTurnUserId: null, message: expect.stringContaining("Saving match result") });
    vi.advanceTimersByTime(999);
    expect(hub.stats().finishedMatches).toBe(0);
    fixture.exec("DROP TRIGGER fail_second_update");
    vi.advanceTimersByTime(1);
    expect(view(sockets[winner])).toMatchObject({ phase: "finished", result: { winnerId: players[winner].profile.userId, reason: "ships_sunk", won: true } });
    const stored = JSON.parse(completionRow().decision_json) as MatchCompletion;
    expect(stored.players.find((p) => p.userId === players[winner].profile.userId)).toMatchObject({ shotsFired: cells.length, hits: cells.length, shipsSunk: 5 });
    expect(completionRow().completed_at).toBe(new Date().toISOString());
    expect(metrics.snapshot().counters).toMatchObject({ matches_finished_total: 1 });
    expect(sockets.map((s) => s.sent.filter((m) => m.type === "match_finished").length)).toEqual([1, 1]);
    const committedProfiles = players.map((p) => database.getProfile(p.profile.userId));
    vi.advanceTimersByTime(99);
    expect(hub.stats().finishedMatches).toBe(1);
    vi.advanceTimersByTime(1);
    expect(hub.stats().matches).toBe(0);
    expect(receiptCount()).toBe(1);
    expect(database.completeMatch({ ...stored, matchId }).applied).toBe(false);
    expect(players.map((p) => database.getProfile(p.profile.userId))).toEqual(committedProfiles);
  });

  it("retries the original forfeit despite the other player's leave, and acknowledgement keeps the receipt", () => {
    const { players, sockets, matchId } = pair();
    failSecondUpdate();
    sockets[0].message({ type: "leave_match" });
    sockets[1].message({ type: "leave_match" });
    fixture.exec("DROP TRIGGER fail_second_update");
    vi.advanceTimersByTime(1000);
    expect(view(sockets[0]).result).toMatchObject({ winnerId: players[1].profile.userId, reason: "forfeit", won: false });
    expect(players.map((p) => database.getProfile(p.profile.userId)!.stats.gamesPlayed)).toEqual([1, 1]);
    const saved = JSON.parse(completionRow().decision_json);
    sockets.forEach((s) => s.message({ type: "leave_match" }));
    expect(hub.stats().matches).toBe(0);
    expect(receiptCount()).toBe(1);
    expect(database.completeMatch({ ...saved, matchId }).applied).toBe(false);
    expect(metrics.snapshot().counters).toMatchObject({ matches_finished_total: 1 });
  });

  it.each([1, 2])("retries a disconnect timeout with %s disconnected participants without changing its decision", (count) => {
    const { players, sockets } = pair();
    failSecondUpdate();
    sockets.slice(0, count).forEach((s) => s.close());
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    const reconnected = connect(players[0]);
    expect(view(reconnected).message).toContain("Saving match result");
    reconnected.message({ type: "leave_match" });
    fixture.exec("DROP TRIGGER fail_second_update");
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(view(reconnected).result).toMatchObject({ winnerId: players[1].profile.userId, won: false });
    expect(players.map((p) => database.getProfile(p.profile.userId)!.stats.gamesPlayed)).toEqual([1, 1]);
    expect(receiptCount()).toBe(1);
  });

  it("stops after three failed attempts and remains frozen across later requests and reconnects", () => {
    const { players, sockets } = pair();
    failSecondUpdate();
    sockets[0].message({ type: "leave_match" });
    expect(vi.getTimerCount()).toBe(3); // Two sessions plus one retry.
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(view(sockets[0]).message).toContain("could not be saved");
    expect(vi.getTimerCount()).toBe(2);
    fixture.exec("DROP TRIGGER fail_second_update");
    sockets[0].close();
    const current = connect(players[0]);
    current.message({ type: "leave_match" });
    current.message({ type: "join_queue" });
    vi.advanceTimersByTime(60_000);
    expect(receiptCount()).toBe(0);
    expect(hub.stats()).toMatchObject({ matches: 1, finishedMatches: 0, queuedPlayers: 0 });
    expect(players.map((p) => database.getProfile(p.profile.userId)!.stats.gamesPlayed)).toEqual([0, 0]);
    const errors = metrics.snapshot().recentEvents as { type: string; message: string }[];
    expect(errors.filter((e) => e.type === "error" && e.message.includes("completion attempt"))).toHaveLength(3);
    hub.resetRuntime();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[4009, "Admin reset"], [1012, "Server restarting"]] as const)("cancels retries and stale callbacks at reset/shutdown (%s)", (code, reason) => {
    const { players, sockets } = pair();
    failSecondUpdate();
    const timers = vi.spyOn(globalThis, "setTimeout");
    sockets[0].message({ type: "leave_match" });
    const stale = timers.mock.calls.find((call) => call[1] === 1000)![0] as () => void;
    hub.resetRuntime(code, reason);
    expect(vi.getTimerCount()).toBe(0);
    fixture.exec("DROP TRIGGER fail_second_update");
    database.resetDatabase("stats");
    const next = players.map(connect);
    next.forEach((s) => s.message({ type: "join_queue" }));
    const id = view(next[0]).matchId;
    stale();
    vi.advanceTimersByTime(5000);
    expect(receiptCount()).toBe(0);
    expect(view(next[0])).toMatchObject({ matchId: id, phase: "placing" });
    next[0].message({ type: "leave_match" });
    expect(receiptCount()).toBe(1);
    expect(players.map((p) => database.getProfile(p.profile.userId)!.stats.gamesPlayed)).toEqual([1, 1]);
  });
});
