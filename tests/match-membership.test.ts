import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { validateFleet, type ClientMessage, type ServerMessage, type ShipPlacement } from "@pixelfleet/shared";
import type { GameHub as Hub } from "../apps/backend/src/game-hub";

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: ServerMessage[] = [];
  closes: { code?: number; reason?: string }[] = [];

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  message(value: ClientMessage) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

const fleet: ShipPlacement[] = [
  { shipId: "battleship", x: 0, y: 0, orientation: "horizontal" },
  { shipId: "cruiser", x: 0, y: 2, orientation: "horizontal" },
  { shipId: "destroyer-a", x: 0, y: 4, orientation: "horizontal" },
  { shipId: "destroyer-b", x: 0, y: 6, orientation: "horizontal" },
  { shipId: "submarine", x: 0, y: 8, orientation: "horizontal" }
];
let directory: string;
let database: typeof import("../apps/backend/src/db");
let GameHub: typeof import("../apps/backend/src/game-hub").GameHub;
let hub: Hub;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-match-membership-"));
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  database?.closeDatabase();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  await rm(directory, { recursive: true, force: true });
});

function guest(username = "Match dummy") {
  const { profile, sessionToken } = database.createGuestAccount(username);
  const session = database.getSessionByToken(sessionToken)!;
  return { profile, sessionId: session.id, expiresAt: session.expiresAt };
}

function connect(player: ReturnType<typeof guest>) {
  const socket = new TestSocket();
  hub.connect(socket as unknown as WebSocket, player.profile, { ip: "127.0.0.1", sessionId: player.sessionId, expiresAt: player.expiresAt });
  return socket;
}

function view(socket: TestSocket) {
  const views = socket.sent.flatMap((item) => {
    if (item.type === "session_snapshot") return item.state.kind === "match" ? [item.state.view] : [];
    return item.type === "game_update" || item.type === "match_finished" ? [item.view] : [];
  });
  const latest = views.at(-1);
  if (!latest) throw new Error("Expected a match view.");
  return latest;
}

function pair(first: TestSocket, second: TestSocket) {
  first.message({ type: "join_queue" });
  second.message({ type: "join_queue" });
  expect(view(first).phase).toBe("placing");
  expect(view(second).matchId).toBe(view(first).matchId);
  return view(first).matchId;
}

function finishedThenNew() {
  const player = guest("Returning dummy");
  const first = connect(player);
  const oldOpponent = connect(guest("Old opponent dummy"));
  const oldId = pair(first, oldOpponent);
  first.message({ type: "leave_match" });
  const result = view(first);
  expect(result).toMatchObject({ matchId: oldId, phase: "finished", result: { reason: "forfeit", won: false } });
  const opponent = connect(guest("New opponent dummy"));
  const newId = pair(first, opponent);
  expect(newId).not.toBe(oldId);
  expect(hub.stats()).toMatchObject({ placingMatches: 1, finishedMatches: 1, queuedPlayers: 0 });
  return { player, first, oldOpponent, opponent, oldId, newId, result };
}

describe("unique active match membership", () => {
  it("routes fleet placement, shots and leaving to the new match while retaining the old result", () => {
    const { player, first, oldOpponent, opponent, newId, result } = finishedThenNew();
    const oldMessages = [...oldOpponent.sent];
    first.message({ type: "place_ships", placements: fleet });
    opponent.message({ type: "place_ships", placements: fleet });
    expect(view(first)).toMatchObject({ matchId: newId, phase: "playing" });
    const shooter = view(first).currentTurnUserId === player.profile.userId ? first : opponent;
    shooter.message({ type: "fire", x: 0, y: 0 });
    expect(view(shooter).enemyBoard.find((cell) => cell.x === 0 && cell.y === 0)?.state).toBe("hit");
    expect(view(first).matchId).toBe(newId);
    expect(view(first).result).toBeUndefined();
    expect(oldOpponent.sent).toEqual(oldMessages);
    expect(first.sent).toContainEqual({ type: "match_finished", view: result });
    first.message({ type: "leave_match" });
    expect(view(first)).toMatchObject({ matchId: newId, phase: "finished", result: { reason: "forfeit", won: false } });
    expect(database.getProfile(player.profile.userId)?.stats.gamesPlayed).toBe(2);
    expect(hub.stats()).toMatchObject({ playingMatches: 0, finishedMatches: 2 });
    expect(first.sent.some((message) => message.type === "error")).toBe(false);
  });

  it("rejects repeated queue entry by either active member without pairing them with a third player", () => {
    const { first, opponent, newId } = finishedThenNew();
    for (const socket of [first, opponent, first, opponent]) socket.message({ type: "join_queue" });
    expect(hub.stats()).toMatchObject({ placingMatches: 1, queuedPlayers: 0 });
    for (const socket of [first, opponent]) {
      expect(socket.sent).toContainEqual({ type: "error", message: "You are already in a match." });
      expect(view(socket).matchId).toBe(newId);
    }
    const outsider = connect(guest("Waiting dummy"));
    outsider.message({ type: "join_queue" });
    expect(hub.stats()).toMatchObject({ placingMatches: 1, queuedPlayers: 1 });
    expect(outsider.sent.some((message) => message.type === "match_found")).toBe(false);
    const other = connect(guest("Other waiting dummy"));
    other.message({ type: "join_queue" });
    expect(view(outsider).opponent.userId).toBe(view(other).you.userId);
    expect(view(outsider).matchId).not.toBe(newId);
    expect(view(first).matchId).toBe(newId);
    expect(view(opponent).matchId).toBe(newId);
    expect(hub.stats()).toMatchObject({ placingMatches: 2, finishedMatches: 1, queuedPlayers: 0 });
  });

  it("disconnects and reconnects the new match and cancels its grace timer despite the old result", () => {
    vi.useFakeTimers();
    const { player, first, oldOpponent, opponent, newId } = finishedThenNew();
    const oldMessages = [...oldOpponent.sent];
    first.close();
    expect(view(opponent)).toMatchObject({ matchId: newId, opponent: { connected: false }, reconnectDeadline: Date.now() + 30_000 });
    vi.advanceTimersByTime(15_000);
    const current = connect(player);
    expect(view(current)).toMatchObject({ matchId: newId, you: { connected: true } });
    expect(view(opponent).opponent.connected).toBe(true);
    expect(view(opponent).reconnectDeadline).toBeUndefined();
    vi.advanceTimersByTime(30_001);
    expect(hub.stats()).toMatchObject({ placingMatches: 1, finishedMatches: 1 });
    expect(oldOpponent.sent).toEqual(oldMessages);
    current.close();
    vi.advanceTimersByTime(30_001);
    expect(view(opponent)).toMatchObject({ matchId: newId, phase: "finished", result: { won: true, reason: "forfeit" } });
    expect(database.getProfile(player.profile.userId)?.stats.gamesPlayed).toBe(2);
  });

  it("releases both memberships after disconnect timeout so the same players can start another match", () => {
    vi.useFakeTimers();
    const player = guest();
    const first = connect(player);
    const opponent = connect(guest());
    const oldId = pair(first, opponent);
    first.close();
    vi.advanceTimersByTime(30_001);
    expect(view(opponent).phase).toBe("finished");
    const current = connect(player);
    const newId = pair(current, opponent);
    expect(newId).not.toBe(oldId);
    current.message({ type: "place_ships", placements: fleet });
    expect(view(opponent)).toMatchObject({ matchId: newId, opponent: { ready: true } });
    expect(hub.stats()).toMatchObject({ placingMatches: 1, finishedMatches: 1 });
  });

  it("preserves normal ships-sunk results and allows both participants into the next match", () => {
    const first = connect(guest());
    const second = connect(guest());
    const oldId = pair(first, second);
    first.message({ type: "place_ships", placements: fleet });
    second.message({ type: "place_ships", placements: fleet });
    const validation = validateFleet(fleet);
    if (!validation.valid) throw new Error(validation.error);
    const cells = validation.ships.flatMap((ship) => ship.cells);
    const shots = new Map([[first, 0], [second, 0]]);
    for (let turn = 0; turn < cells.length * 2 - 1; turn += 1) {
      const shooter = view(first).currentTurnUserId === view(first).you.userId ? first : second;
      const index = shots.get(shooter)!;
      shooter.message({ type: "fire", ...cells[index] });
      shots.set(shooter, index + 1);
    }
    expect(view(first)).toMatchObject({ matchId: oldId, phase: "finished", result: { reason: "ships_sunk" } });
    expect(view(first).result?.won).not.toBe(view(second).result?.won);
    expect(view(first).result?.profile.stats.gamesPlayed).toBe(1);
    expect(view(second).result?.profile.stats.gamesPlayed).toBe(1);
    expect(pair(first, second)).not.toBe(oldId);
    expect(hub.stats()).toMatchObject({ placingMatches: 1, finishedMatches: 1 });
  });

  it("keeps finished-result acknowledgement and cleanup available without an active match", () => {
    const first = connect(guest());
    const second = connect(guest());
    pair(first, second);
    first.message({ type: "leave_match" });
    const result = view(first);
    first.message({ type: "leave_match" });
    expect(hub.stats().finishedMatches).toBe(1);
    second.message({ type: "leave_match" });
    expect(hub.stats().matches).toBe(0);
    expect(result.result?.profile.stats.gamesPlayed).toBe(1);
    expect(first.sent).toContainEqual({ type: "match_finished", view: result });
    first.message({ type: "place_ships", placements: fleet });
    expect(first.sent).toContainEqual({ type: "error", message: "No active match found." });
  });

  it("clears active memberships and old disconnect timers on runtime reset", () => {
    vi.useFakeTimers();
    const firstPlayer = guest();
    const secondPlayer = guest();
    const first = connect(firstPlayer);
    const second = connect(secondPlayer);
    const oldId = pair(first, second);
    first.close();
    expect(hub.resetRuntime()).toMatchObject({ activeConnections: 0, queuedPlayers: 0, matches: 0 });
    const current = connect(firstPlayer);
    const opponent = connect(secondPlayer);
    const newId = pair(current, opponent);
    expect(newId).not.toBe(oldId);
    vi.advanceTimersByTime(30_001);
    expect(view(current)).toMatchObject({ matchId: newId, phase: "placing", you: { connected: true } });
    expect(hub.stats()).toMatchObject({ placingMatches: 1, finishedMatches: 0 });
    expect(database.getProfile(firstPlayer.profile.userId)?.stats.gamesPlayed).toBe(0);
  });
});

describe("finished match retention (TD-02)", () => {
  const retention = 600_000;

  beforeEach(() => vi.useFakeTimers());

  it("expires a result after both players disconnected before completion, without any later activity", () => {
    const players = [guest(), guest()];
    const first = connect(players[0]);
    const second = connect(players[1]);
    pair(first, second);
    first.close();
    second.close();
    vi.advanceTimersByTime(29_999);
    expect(hub.stats()).toMatchObject({ placingMatches: 1, finishedMatches: 0 });
    expect(database.getProfile(players[0].profile.userId)?.stats.gamesPlayed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(hub.stats()).toMatchObject({ activeConnections: 0, finishedMatches: 1 });
    expect(vi.getTimerCount()).toBe(1);
    const profiles = players.map((player) => database.getProfile(player.profile.userId));
    expect(profiles.map((profile) => profile?.stats.gamesPlayed)).toEqual([1, 1]);
    vi.advanceTimersByTime(retention - 1);
    expect(hub.stats().finishedMatches).toBe(1);
    vi.advanceTimersByTime(1);
    expect(hub.stats().matches).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(players.map((player) => database.getProfile(player.profile.userId))).toEqual(profiles);
  });

  it("keeps a one-sided timeout result retrievable until its original deadline", () => {
    const player = guest();
    const other = guest();
    const first = connect(player);
    const opponent = connect(other);
    const id = pair(first, opponent);
    first.close();
    vi.advanceTimersByTime(30_000);
    const profiles = [player, other].map((entry) => database.getProfile(entry.profile.userId));
    vi.advanceTimersByTime(retention - 1);
    const current = connect(player);
    expect(view(current)).toMatchObject({ matchId: id, phase: "finished", result: { reason: "forfeit", won: false } });
    current.close();
    expect(hub.stats().finishedMatches).toBe(1);
    vi.advanceTimersByTime(1);
    expect(hub.stats().finishedMatches).toBe(0);
    expect(connect(player).sent.some((message) => message.type === "match_finished")).toBe(false);
    expect([player, other].map((entry) => database.getProfile(entry.profile.userId))).toEqual(profiles);
  });

  it("does not treat disconnects after completion as result acknowledgements", () => {
    const players = [guest(), guest()];
    const first = connect(players[0]);
    const second = connect(players[1]);
    const id = pair(first, second);
    first.message({ type: "leave_match" });
    first.close();
    second.close();
    expect(hub.stats()).toMatchObject({ activeConnections: 0, finishedMatches: 1 });
    const current = connect(players[0]);
    expect(view(current)).toMatchObject({ matchId: id, phase: "finished" });
    current.close();
    vi.advanceTimersByTime(retention);
    expect(hub.stats().matches).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["forfeit", "ships_sunk"])("expires a regular %s result from completion, preserving XP and statistics", (reason) => {
    const players = [guest(), guest()];
    const first = connect(players[0]);
    const second = connect(players[1]);
    pair(first, second);
    vi.advanceTimersByTime(5000);
    if (reason === "forfeit") first.message({ type: "leave_match" });
    else {
      first.message({ type: "place_ships", placements: fleet });
      second.message({ type: "place_ships", placements: fleet });
      const validation = validateFleet(fleet);
      if (!validation.valid) throw new Error(validation.error);
      const cells = validation.ships.flatMap((ship) => ship.cells);
      const shots = new Map([[first, 0], [second, 0]]);
      for (let turn = 0; turn < cells.length * 2 - 1; turn += 1) {
        const shooter = view(first).currentTurnUserId === players[0].profile.userId ? first : second;
        const index = shots.get(shooter)!;
        shooter.message({ type: "fire", ...cells[index] });
        shots.set(shooter, index + 1);
      }
    }
    expect(view(first)).toMatchObject({ phase: "finished", result: { reason } });
    const profiles = players.map((player) => database.getProfile(player.profile.userId));
    expect(profiles.every((profile) => profile!.xp > 0 && profile!.stats.gamesPlayed === 1)).toBe(true);
    vi.advanceTimersByTime(retention - 1);
    expect(hub.stats().finishedMatches).toBe(1);
    const before = first.sent.length;
    vi.advanceTimersByTime(1);
    expect(hub.stats().matches).toBe(0);
    expect(first.sent).toHaveLength(before);
    expect(players.map((player) => database.getProfile(player.profile.userId))).toEqual(profiles);
    expect(vi.getTimerCount()).toBe(2); // Only the two session expiry timers remain.
  });

  it("clears the retention timer after explicit acknowledgements without touching a newer match", () => {
    const player = guest();
    const first = connect(player);
    const second = connect(guest());
    pair(first, second);
    const timers = vi.spyOn(globalThis, "setTimeout");
    first.message({ type: "leave_match" });
    expect(vi.getTimerCount()).toBe(3);
    const expired = timers.mock.calls.find((call) => call[1] === retention)![0] as () => void;
    first.message({ type: "leave_match" });
    first.message({ type: "leave_match" });
    expect(hub.stats().finishedMatches).toBe(1);
    const newerOpponent = connect(guest());
    const id = pair(first, newerOpponent);
    second.message({ type: "leave_match" });
    expect(hub.stats()).toMatchObject({ finishedMatches: 0, placingMatches: 1 });
    expect(vi.getTimerCount()).toBe(3); // Only the three connected sessions remain.
    expired(); // Simulate a cancelled callback already queued by the event loop.
    first.message({ type: "place_ships", placements: fleet });
    expect(view(newerOpponent)).toMatchObject({ matchId: id, phase: "placing", opponent: { ready: true } });
    expect(database.getProfile(player.profile.userId)?.stats.gamesPlayed).toBe(1);
  });

  it("expires multiple older results independently while the same account plays a newer match", () => {
    const player = guest();
    let first = connect(player);
    const oldOpponent = connect(guest());
    pair(first, oldOpponent);
    first.message({ type: "leave_match" });
    vi.advanceTimersByTime(1000);
    const secondOpponent = connect(guest());
    pair(first, secondOpponent);
    first.message({ type: "leave_match" });
    vi.advanceTimersByTime(1000);
    const opponent = connect(guest());
    const id = pair(first, opponent);
    first.message({ type: "place_ships", placements: fleet });
    opponent.message({ type: "place_ships", placements: fleet });
    first.close();
    first = connect(player);
    expect(view(first)).toMatchObject({ matchId: id, phase: "playing" });
    expect(first.sent.some((message) => message.type === "match_finished")).toBe(false);
    const profile = database.getProfile(player.profile.userId);
    vi.advanceTimersByTime(retention - 2000);
    expect(hub.stats()).toMatchObject({ playingMatches: 1, finishedMatches: 1 });
    vi.advanceTimersByTime(1000);
    expect(hub.stats()).toMatchObject({ playingMatches: 1, finishedMatches: 0, matches: 1 });
    const shooter = view(first).currentTurnUserId === player.profile.userId ? first : opponent;
    shooter.message({ type: "fire", x: 0, y: 0 });
    expect(view(shooter).enemyBoard.find((cell) => cell.x === 0 && cell.y === 0)?.state).toBe("hit");
    expect(view(first).matchId).toBe(id);
    expect(database.getProfile(player.profile.userId)).toEqual(profile);
    expect(first.sent.some((message) => message.type === "error")).toBe(false);
  });

  it("replays the latest unacknowledged result and keeps older results independently available", () => {
    const player = guest();
    const first = connect(player);
    const other = connect(guest());
    const oldId = pair(first, other);
    first.message({ type: "leave_match" });
    vi.advanceTimersByTime(1000);
    const newId = pair(first, other);
    first.message({ type: "leave_match" });
    first.close();
    const current = connect(player);
    expect(view(current).matchId).toBe(newId);
    current.message({ type: "leave_match" });
    current.close();
    expect(view(connect(player)).matchId).toBe(oldId);
    vi.advanceTimersByTime(retention - 1000);
    expect(hub.stats().finishedMatches).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(hub.stats().finishedMatches).toBe(0);
    expect(database.getProfile(player.profile.userId)?.stats.gamesPlayed).toBe(2);
  });

  it.each([[4009, "Admin reset"], [1012, "Server restarting"]] as const)("clears results, timers and references on reset/shutdown (%s)", (code, reason) => {
    const player = guest();
    const other = guest();
    const first = connect(player);
    const second = connect(other);
    pair(first, second);
    first.message({ type: "leave_match" });
    const profile = database.getProfile(player.profile.userId);
    pair(first, second);
    first.close();
    expect(vi.getTimerCount()).toBe(3); // Retention, reconnect grace, second session.
    expect(hub.resetRuntime(code, reason)).toMatchObject({ activeConnections: 0, matches: 0 });
    expect(vi.getTimerCount()).toBe(0);
    expect(second.closes).toContainEqual({ code, reason });
    const current = connect(player);
    const opponent = connect(other);
    const id = pair(current, opponent);
    vi.advanceTimersByTime(retention + 30_000);
    expect(view(current)).toMatchObject({ matchId: id, phase: "placing" });
    expect(hub.stats()).toMatchObject({ placingMatches: 1, finishedMatches: 0 });
    expect(database.getProfile(player.profile.userId)).toEqual(profile);
  });

  it("does not replay an expired result when the event loop has delayed its timer", () => {
    const player = guest();
    const first = connect(player);
    const second = connect(guest());
    pair(first, second);
    first.message({ type: "leave_match" });
    vi.setSystemTime(Date.now() + retention);
    const current = connect(player);
    expect(current.sent.some((message) => message.type === "match_finished")).toBe(false);
    expect(hub.stats().finishedMatches).toBe(0);
    expect(vi.getTimerCount()).toBe(2);
  });

  it.each(["0", "-1", "1.5", "100ms", "NaN", "Infinity", "600001", "9007199254740992", " "])("rejects invalid retention configuration %j", (value) => {
    vi.stubEnv("FINISHED_MATCH_RETENTION_MS", value);
    expect(() => new GameHub()).toThrow(/FINISHED_MATCH_RETENTION_MS/);
  });

  it.each(["1", "1000", "600000"])("uses a validated retention of %s milliseconds from completion", (value) => {
    hub.resetRuntime();
    vi.stubEnv("FINISHED_MATCH_RETENTION_MS", value);
    hub = new GameHub();
    const first = connect(guest());
    const second = connect(guest());
    pair(first, second);
    vi.advanceTimersByTime(5000);
    expect(hub.stats().placingMatches).toBe(1);
    first.message({ type: "leave_match" });
    vi.advanceTimersByTime(Number(value) - 1);
    expect(hub.stats().finishedMatches).toBe(1);
    vi.advanceTimersByTime(1);
    expect(hub.stats().matches).toBe(0);
  });
});
