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

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close() {
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
});

afterAll(async () => {
  database?.closeDatabase();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  await rm(directory, { recursive: true, force: true });
});

function guest(username = "Match dummy") {
  const { profile, sessionToken } = database.createGuestAccount(username);
  return { profile, sessionId: database.getSessionByToken(sessionToken)!.id };
}

function connect(player: ReturnType<typeof guest>) {
  const socket = new TestSocket();
  hub.connect(socket as unknown as WebSocket, player.profile, { ip: "127.0.0.1", sessionId: player.sessionId });
  return socket;
}

function view(socket: TestSocket) {
  const message = socket.sent.filter((item) => item.type === "game_update" || item.type === "match_finished").at(-1);
  if (!message || (message.type !== "game_update" && message.type !== "match_finished")) {
    throw new Error("Expected a match view.");
  }
  return message.view;
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
