// @vitest-environment jsdom
import React, { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as ServerWebSocket } from "ws";
import { WS_PROTOCOL, type ClientMessage, type ServerMessage, type ShipPlacement } from "@pixelfleet/shared";
import App from "../apps/frontend/src/App";
import type { GameHub } from "../apps/backend/src/game-hub";

let directory: string;
let database: typeof import("../apps/backend/src/db");
let Hub: typeof GameHub;
let hub: GameHub;
let fixture: DatabaseSync;
let account: ReturnType<typeof guest>;
let sockets: BrowserSocket[];
let roots: Root[];
let container: HTMLDivElement;
const originalDatabasePath = process.env.DATABASE_PATH;

// Only the transport is simulated. Real App -> SessionConnection -> wire JSON ->
// GameHub -> SQLite -> wire JSON -> SessionConnection -> React DOM runs end to end.
class ServerSocket extends EventEmitter {
  readyState = 1;
  sent: ServerMessage[] = [];
  constructor(private readonly peer?: BrowserSocket) { super(); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); this.peer?.receive(raw); }
  message(message: ClientMessage) { this.emit("message", Buffer.from(JSON.stringify(message))); }
  close(code = 1006) {
    if (this.readyState === 3) return;
    this.readyState = 3; this.emit("close"); this.peer?.closed(code);
  }
}

class BrowserSocket {
  readyState = 0;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  server = new ServerSocket(this);
  held: string[] = [];
  hold = false;
  sent: ClientMessage[] = [];
  constructor(_url: string, protocol: string) { expect(protocol).toBe(WS_PROTOCOL); sockets.push(this); }
  open() {
    const session = database.getSessionByToken(account.sessionToken);
    if (!session) { this.closed(4003); return; }
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, {} as Event);
    hub.connect(this.server as unknown as ServerWebSocket, session.profile, { ip: "127.0.0.1", sessionId: session.id, expiresAt: session.expiresAt });
  }
  receive(raw: string) {
    if (this.hold) this.held.push(raw);
    else this.onmessage?.call(this as unknown as WebSocket, { data: raw } as MessageEvent);
  }
  flush() { this.hold = false; for (const raw of this.held.splice(0)) this.receive(raw); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); this.server.emit("message", Buffer.from(raw)); }
  closed(code: number) { this.readyState = 3; this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent); }
  close() { this.readyState = 2; this.server.close(1000); }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-reconnect-"));
  process.env.DATABASE_PATH = join(directory, "fixture.sqlite");
  database = await import("../apps/backend/src/db");
  ({ GameHub: Hub } = await import("../apps/backend/src/game-hub"));
  fixture = new DatabaseSync(process.env.DATABASE_PATH);
});

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", BrowserSocket);
  database.resetDatabase("all"); hub = new Hub(); sockets = []; roots = [];
  account = guest("Snapshot captain");
  container = document.createElement("div"); document.body.appendChild(container);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/me") {
      const session = database.getSessionByToken(account.sessionToken);
      return new Response(JSON.stringify(session ? { profile: session.profile } : { error: "Not logged in." }), { status: session ? 200 : 401 });
    }
    if (path === "/api/logout") {
      const id = database.deleteSession(account.sessionToken); if (id) hub.revokeSession(id);
      return new Response('{"ok":true}');
    }
    throw new Error(`Unexpected fixture path ${path}`);
  }));
});

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); hub.resetRuntime(); });
  fixture.exec("DROP TRIGGER IF EXISTS fail_completion");
  document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

afterAll(async () => {
  fixture?.close(); database?.closeDatabase();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = originalDatabasePath;
  await rm(directory, { recursive: true, force: true });
});

function guest(name = "Opponent fixture") { return database.createGuestAccount(name); }
function opponent(player = guest()) {
  const socket = new ServerSocket(); const session = database.getSessionByToken(player.sessionToken)!;
  hub.connect(socket as unknown as ServerWebSocket, session.profile, { ip: "127.0.0.2", sessionId: session.id, expiresAt: session.expiresAt });
  return socket;
}
function button(text: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}. ${container.textContent}`);
  return button;
}
async function click(text: string) { await act(async () => button(text).click()); }
function latestView(socket: ServerSocket) {
  const views = socket.sent.flatMap((m) => m.type === "session_snapshot" ? (m.state.kind === "match" ? [m.state.view] : [])
    : m.type === "game_update" || m.type === "match_finished" ? [m.view] : []);
  return views.at(-1)!;
}
async function mount(strict = false, initialize = true) {
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(strict ? <StrictMode><App /></StrictMode> : <App />));
  const socket = sockets.at(-1)!;
  if (initialize) await act(async () => socket.open());
  return socket;
}
async function reconnect(socket: BrowserSocket, elapsed = 1200, initialize = true) {
  await act(async () => socket.server.close());
  await act(async () => vi.advanceTimersByTime(elapsed));
  const current = sockets.at(-1)!; expect(current).not.toBe(socket);
  if (initialize) await act(async () => current.open());
  return current;
}
async function pair() {
  const browser = await mount(); const other = opponent();
  await click("Start Game");
  await act(async () => other.message({ type: "join_queue" }));
  expect(container.textContent).toContain("Your Shipyard");
  return { browser, other, id: latestView(browser.server).matchId };
}
function failCompletion() { fixture.exec("CREATE TRIGGER fail_completion BEFORE UPDATE OF games_played ON users BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END"); }
const fleet: ShipPlacement[] = [
  { shipId: "battleship", x: 0, y: 0, orientation: "horizontal" }, { shipId: "cruiser", x: 0, y: 2, orientation: "horizontal" },
  { shipId: "destroyer-a", x: 0, y: 4, orientation: "horizontal" }, { shipId: "destroyer-b", x: 0, y: 6, orientation: "horizontal" },
  { shipId: "submarine", x: 0, y: 8, orientation: "horizontal" }
];

describe("authoritative reconnect through real React mounts (TD-06)", () => {
  it("initializes Strict Mode once from a complete lobby and enables actions only after the snapshot", async () => {
    const browser = await mount(true, false);
    expect(button("Start Game").disabled).toBe(true);
    browser.hold = true; await act(async () => browser.open());
    expect(button("Start Game").disabled).toBe(true); await click("Start Game"); expect(browser.sent).toEqual([]);
    await act(async () => browser.flush());
    expect(button("Start Game").disabled).toBe(false);
    expect(browser.server.sent).toEqual([{ type: "session_snapshot", profile: account.profile, state: { kind: "lobby" } }]);
    expect(hub.stats().activeConnections).toBe(1);
  });

  it("removes a disconnected queue and supports cancel and a new search after reconnect", async () => {
    const browser = await mount(); await click("Start Game");
    expect(hub.stats().queuedPlayers).toBe(1);
    const current = await reconnect(browser, 1200, false);
    expect(hub.stats().queuedPlayers).toBe(0); expect(button("Cancel Search").disabled).toBe(true);
    await act(async () => current.open());
    expect(container.textContent).not.toContain("Searching for an opponent");
    await click("Start Game"); await click("Cancel Search");
    expect(button("Start Game").disabled).toBe(false); expect(hub.stats().queuedPlayers).toBe(0);
  });

  it("preserves queue membership on socket replacement and ignores the old close/actions", async () => {
    const old = await mount(); await click("Start Game");
    const oldContainer = container;
    container = document.createElement("div"); document.body.appendChild(container);
    const current = await mount();
    expect(current.server.sent[0]).toMatchObject({ type: "session_snapshot", state: { kind: "queue" } });
    expect(container.textContent).toContain("Searching for an opponent");
    expect(oldContainer.textContent).toContain("Another connection replaced this one.");
    await act(async () => { old.server.message({ type: "cancel_queue" }); old.server.emit("close"); vi.advanceTimersByTime(5000); });
    expect(hub.stats()).toMatchObject({ queuedPlayers: 1, activeConnections: 1 });
    expect(oldContainer.querySelector<HTMLButtonElement>("main button")!.disabled).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it("retains unconfirmed placements during a short disconnect and a snapshot of the same match", async () => {
    const { browser, id } = await pair(); await click("Random");
    const cells = () => [...container.querySelectorAll('[aria-label="Your placement"] .cell-ship')].map((cell) => cell.getAttribute("aria-label"));
    const draft = cells(); expect(draft).toHaveLength(17);
    const current = await reconnect(browser, 1200, false);
    expect(cells()).toEqual(draft); expect(button("Confirm").disabled).toBe(true);
    await act(async () => current.open());
    expect(latestView(current.server).matchId).toBe(id); expect(cells()).toEqual(draft);
    expect(button("Confirm").disabled).toBe(false); await click("Confirm");
    expect(container.textContent).toContain("Fleet confirmed");
    expect(latestView(current.server).you.ready).toBe(true);
  });

  it("discards a draft when a snapshot replaces the match even for the same account", async () => {
    const { browser, other, id } = await pair(); await click("Random");
    await act(async () => {
      browser.hold = true; other.message({ type: "leave_match" });
      browser.server.message({ type: "join_queue" }); opponent().message({ type: "join_queue" });
    });
    const current = await reconnect(browser);
    expect(latestView(current.server).matchId).not.toBe(id);
    expect(container.querySelectorAll('[aria-label="Your placement"] .cell-ship')).toHaveLength(0);
    expect(button("Confirm").disabled).toBe(true);
  });

  it("keeps a newly found match when an earlier queue cancellation arrives afterward", async () => {
    const { browser, id } = await pair();
    await act(async () => browser.server.message({ type: "cancel_queue" }));
    expect(latestView(browser.server).matchId).toBe(id);
    expect(container.textContent).toContain("Your Shipyard");
  });

  it("discards unconfirmed local inputs when the same match snapshot confirms the fleet", async () => {
    const { browser } = await pair(); await click("Random");
    await act(async () => { browser.hold = true; browser.server.message({ type: "place_ships", placements: fleet }); });
    const current = await reconnect(browser);
    expect(latestView(current.server).you.ready).toBe(true);
    expect(container.querySelector('[aria-label="Your placement"]')).toBeNull();
    expect(container.textContent).toContain("Fleet confirmed");
    expect(container.querySelectorAll('[aria-label="Your Fleet"] .cell-ship')).toHaveLength(17);
  });

  it("selects the newest unacknowledged retained result without changing rewards", async () => {
    const { browser, other } = await pair();
    await act(async () => other.message({ type: "leave_match" }));
    let newest = latestView(browser.server).matchId;
    for (let index = 0; index < 2; index++) await act(async () => {
      browser.server.message({ type: "join_queue" }); const next = opponent(); next.message({ type: "join_queue" });
      next.message({ type: "leave_match" }); newest = latestView(browser.server).matchId;
    });
    const xp = database.getProfile(account.profile.userId)!.xp;
    const current = await reconnect(browser);
    expect(latestView(current.server)).toMatchObject({ matchId: newest, phase: "finished" });
    expect(container.textContent).toContain("Fleet Victorious");
    expect(database.getProfile(account.profile.userId)).toMatchObject({ xp, stats: { gamesPlayed: 3 } });
  });

  it.each(["placing", "playing"])("reconciles %s before the grace deadline without exposing hidden ships", async (phase) => {
    const { browser, other, id } = await pair();
    if (phase === "playing") await act(async () => { browser.server.message({ type: "place_ships", placements: fleet }); other.message({ type: "place_ships", placements: fleet }); });
    const current = await reconnect(browser, 29_999);
    const view = latestView(current.server);
    expect(view).toMatchObject({ matchId: id, phase, you: { connected: true } });
    expect(view.enemyBoard.every((cell) => cell.state === "unknown" && cell.shipId === undefined)).toBe(true);
    expect(container.textContent).toContain(phase === "playing" ? "Target Grid" : "Your Shipyard");
    expect(view.result).toBeUndefined();
  });

  it.each([30_000, 31_000])("replays the committed result after the grace deadline (%i ms)", async (elapsed) => {
    const { browser, id } = await pair();
    const current = await reconnect(browser, elapsed);
    expect(latestView(current.server)).toMatchObject({ matchId: id, phase: "finished", result: { won: false } });
    expect(container.textContent).toContain("Fleet Lost");
    expect(database.getProfile(account.profile.userId)!.stats.gamesPlayed).toBe(1);
  });

  it("enforces the grace boundary even when its timer callback has not run", async () => {
    const { browser } = await pair();
    const current = await reconnect(browser, 1200, false);
    vi.setSystemTime(Date.now() + 28_800);
    await act(async () => current.open());
    expect(latestView(current.server).phase).toBe("finished");
    expect(container.textContent).toContain("Fleet Lost");
  });

  it("keeps disconnect order when both grace deadlines are equal and callbacks are delayed", async () => {
    const { browser, other } = await pair();
    await act(async () => { browser.server.close(); other.close(); vi.advanceTimersByTime(1200); });
    vi.setSystemTime(Date.now() + 28_800);
    const current = sockets.at(-1)!;
    await act(async () => current.open());
    expect(latestView(current.server)).toMatchObject({ phase: "finished", result: { won: false } });
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(database.getProfile(account.profile.userId)!.stats.gamesPlayed).toBe(1);
  });

  it.each(["retained", "expired", "acknowledged"])("reconciles a %s result and does not rebook rewards", async (state) => {
    const { browser, other } = await pair();
    await act(async () => other.message({ type: "leave_match" }));
    const xp = database.getProfile(account.profile.userId)!.xp;
    if (state === "acknowledged") await click("Back to Lobby");
    const current = await reconnect(browser, state === "expired" ? 600_000 : 1200);
    if (state === "retained") expect(container.textContent).toContain("Fleet Victorious");
    else { expect(button("Start Game").disabled).toBe(false); expect(current.server.sent[0]).toMatchObject({ state: { kind: "lobby" } }); }
    expect(database.getProfile(account.profile.userId)!.xp).toBe(xp);
  });

  it("prefers a newer match and a blocked completion over an older unacknowledged result", async () => {
    const { browser, other, id } = await pair();
    await act(async () => {
      other.message({ type: "leave_match" }); browser.server.message({ type: "join_queue" }); opponent().message({ type: "join_queue" });
    });
    let current = await reconnect(browser);
    const newerId = latestView(current.server).matchId;
    expect(newerId).not.toBe(id); expect(container.textContent).toContain("Your Shipyard");
    failCompletion(); await act(async () => current.server.message({ type: "leave_match" }));
    current = await reconnect(current, 1200);
    expect(latestView(current.server)).toMatchObject({ matchId: newerId, phase: "saving" });
    expect(container.textContent).toContain("Saving match result");
    expect(container.textContent).not.toContain("Fleet Victorious");
  });

  it.each(["runtime", "stats", "restart"])("clears old match and draft after %s with the same valid session", async (scope) => {
    const { browser } = await pair(); await click("Random");
    await act(async () => {
      hub.resetRuntime(scope === "restart" ? 1012 : 4009);
      if (scope === "stats") database.resetDatabase("stats");
      if (scope === "restart") hub = new Hub();
      vi.advanceTimersByTime(1200);
    });
    expect(database.getSessionByToken(account.sessionToken)?.profile.userId).toBe(account.profile.userId);
    const current = sockets.at(-1)!; expect(current).not.toBe(browser);
    await act(async () => current.open()); expect(button("Start Game").disabled).toBe(false);
    expect(container.textContent).not.toContain("Your Shipyard");
    await click("Start Game"); await act(async () => opponent().message({ type: "join_queue" }));
    expect(container.querySelectorAll('[aria-label="Your placement"] .cell-ship')).toHaveLength(0);
  });

  it("renders pending and failed persistence explicitly, stops controls and survives reconnect", async () => {
    const { browser } = await pair(); await click("Random"); failCompletion();
    await act(async () => browser.server.message({ type: "leave_match" }));
    expect(container.textContent).toContain("Saving match result");
    expect(container.textContent).not.toContain("Your Shipyard");
    let current = await reconnect(browser, 1200);
    expect(latestView(current.server).phase).toBe("saving");
    await act(async () => vi.advanceTimersByTime(800));
    expect(container.textContent).toContain("Saving failed. Play is locked.");
    current = await reconnect(current);
    expect(latestView(current.server).phase).toBe("save_failed");
    expect(container.querySelectorAll("main button")).toHaveLength(0);
    expect(container.textContent).not.toContain("Fleet Lost");
    expect(database.getProfile(account.profile.userId)!.stats.gamesPlayed).toBe(0);
  });

  it("applies a queued initial snapshot before a commit occurring during reconnection", async () => {
    const { browser } = await pair(); failCompletion();
    await act(async () => browser.server.message({ type: "leave_match" }));
    const current = await reconnect(browser, 1200, false);
    current.hold = true; await act(async () => current.open());
    expect(JSON.parse(current.held[0])).toMatchObject({ type: "session_snapshot", state: { view: { phase: "saving" } } });
    fixture.exec("DROP TRIGGER fail_completion");
    await act(async () => { vi.advanceTimersByTime(800); current.flush(); });
    expect(current.server.sent.map((m) => m.type)).toEqual(["session_snapshot", "profile", "match_finished"]);
    expect(container.textContent).toContain("Fleet Lost");
    expect(container.textContent).not.toContain("Saving match result");
    expect(database.getProfile(account.profile.userId)!.stats.gamesPlayed).toBe(1);
  });

  it("drops old-account placements and ignores late old socket events after HTTP account change", async () => {
    const { browser } = await pair(); await click("Random");
    const newAccount = guest("New captain"); account = newAccount;
    const current = await reconnect(browser);
    expect(container.textContent).toContain("New captain"); expect(container.textContent).not.toContain("Your Shipyard");
    await act(async () => {
      browser.readyState = 1;
      browser.receive(JSON.stringify({ type: "game_update", view: latestView(browser.server) }));
      browser.closed(4003); browser.closed(1006);
    });
    expect(container.textContent).toContain("New captain"); expect(button("Start Game").disabled).toBe(false);
    await click("Start Game"); await act(async () => opponent().message({ type: "join_queue" }));
    expect(latestView(current.server).you.userId).toBe(newAccount.profile.userId);
    expect(container.querySelectorAll('[aria-label="Your placement"] .cell-ship')).toHaveLength(0);
  });

  it("clears the mounted account on logout without resurrecting it", async () => {
    const browser = await mount(); await click("Profile"); await click("Clear Cookie");
    expect(database.getSessionByToken(account.sessionToken)).toBeNull();
    expect(container.textContent).toContain("Guest Login");
    await act(async () => { browser.closed(1006); vi.advanceTimersByTime(5000); });
    expect(sockets).toHaveLength(1);
  });

  it("clears the mounted account and draft when its session expires", async () => {
    const { browser } = await pair(); await click("Random");
    await act(async () => { vi.setSystemTime(account.expiresAt); browser.server.message({ type: "join_queue" }); });
    expect(container.textContent).toContain("Guest Login");
    expect(container.querySelector('[aria-label="Your placement"]')).toBeNull();
    await act(async () => { browser.closed(1006); vi.advanceTimersByTime(5000); });
    expect(sockets).toHaveLength(1);
  });
});
