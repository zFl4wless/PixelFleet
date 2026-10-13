import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { SHIP_DEFINITIONS, type Coordinate, type PlayerProfile, type PublicMatchView, type ServerMessage, type SessionSnapshot } from "@pixelfleet/shared";

export { expect };
const letters = "ABCDEFGHIJ";
export const fleet = SHIP_DEFINITIONS.map((ship, index) => ({ ...ship, x: 0, y: index * 2 }));
export const targets: Coordinate[] = fleet.flatMap((ship) => Array.from({ length: ship.length }, (_, x) => ({ x, y: ship.y })));

class Backend {
  child?: ChildProcess;
  exited?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  port = 0;
  output = "";
  constructor(readonly directory: string) {}
  get url() { return `http://127.0.0.1:${this.port}`; }

  async start() {
    const child = spawn(process.execPath, ["apps/backend/dist/server.js"], {
      env: {
        ...process.env, NODE_ENV: "production", PORT: String(this.port),
        DATABASE_PATH: join(this.directory, "fixture.sqlite"),
        FRONTEND_DIST_DIR: join(process.cwd(), "apps/frontend/dist"),
        FRONTEND_ORIGIN: "", ADMIN_TOKEN: "", TRUST_PROXY: "false",
        HTTP_REQUESTS_PER_MINUTE: "240", GUEST_LOGINS_PER_HOUR: "12",
        WS_CONNECTS_PER_MINUTE: "30", MAX_WS_PER_IP: "20",
        WS_MESSAGES_PER_10S: "120", FIRE_ACTIONS_PER_10S: "120", QUEUE_ACTIONS_PER_MINUTE: "12"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    // Bounded and only ever derived from this test's isolated backend.
    const record = (data: Buffer) => { this.output = (this.output + data.toString()).slice(-64_000); };
    child.stdout!.on("data", record);
    child.stderr!.on("data", record);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Backend readiness timed out: ${this.output}`)), 10_000);
      const ready = (data: Buffer) => {
        const port = data.toString().match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
        if (port) { this.port = Number(port); clearTimeout(timer); child.stdout!.off("data", ready); resolve(); }
      };
      child.stdout!.on("data", ready);
      this.exited!.then((status) => { clearTimeout(timer); reject(new Error(`Backend exited: ${JSON.stringify(status)} ${this.output}`)); }, (error) => { clearTimeout(timer); reject(error); });
    });
    const health = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(5000) });
    expect(health.status).toBe(200);
  }

  async stop() {
    if (!this.child || !this.exited) return;
    const child = this.child;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      expect(await this.exited, `Backend shutdown: ${this.output}`).toEqual({ code: 0, signal: null });
    } finally { clearTimeout(watchdog); }
  }
}

export class Captain {
  profile?: PlayerProfile;
  view?: PublicMatchView;
  snapshots: SessionSnapshot[] = [];
  messages: ServerMessage[] = [];
  issues: string[] = [];
  closed = 0;
  allowMissingSession = true;
  restarting = false;

  constructor(readonly context: BrowserContext, readonly page: Page, readonly url: string) {
    page.on("pageerror", (error) => this.issues.push(`JavaScript page error: ${error.message}`));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      if (this.allowMissingSession && response.request().method() === "GET" && response.url() === `${url}/api/me` && response.status() === 401) return;
      this.issues.push(`Unexpected HTTP ${response.status()}: ${response.url()}`);
    });
    page.on("requestfailed", (request) => {
      if (this.restarting && request.method() === "GET" && request.url() === `${url}/api/me` && /ERR_CONNECTION_(REFUSED|RESET)/.test(request.failure()?.errorText ?? "")) return;
      this.issues.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`);
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // Narrow allowances: anonymous /api/me, or that same endpoint / websocket
      // during our explicit restart only. Uncaught exceptions are never allowed.
      if (this.allowMissingSession && message.location().url === `${url}/api/me` && /Failed to load resource:.*401/.test(text)) return;
      if (this.restarting && message.location().url === `${url}/api/me` && /Failed to load resource:.*ERR_CONNECTION_(REFUSED|RESET)/.test(text)) return;
      if (this.restarting && text.startsWith(`WebSocket connection to '${url.replace(/^http/, "ws")}/ws' failed:`) && /ERR_CONNECTION_(REFUSED|RESET)|closed before the connection is established/.test(text)) return;
      this.issues.push(`Console error: ${text}`);
    });
    page.on("websocket", (socket) => {
      if (socket.url() !== `${url.replace(/^http/, "ws")}/ws`) this.issues.push(`Unexpected WebSocket: ${socket.url()}`);
      socket.on("close", () => { this.closed++; });
      socket.on("socketerror", (error) => {
        if (this.restarting && socket.url() === `${url.replace(/^http/, "ws")}/ws` && /ERR_CONNECTION_(REFUSED|RESET)|closed before.*handshake/i.test(error)) return;
        this.issues.push(`WebSocket error: ${error}`);
      });
      socket.on("framereceived", ({ payload }) => {
        let message: ServerMessage;
        try { message = JSON.parse(payload.toString()) as ServerMessage; }
        catch { this.issues.push("Malformed backend WebSocket JSON"); return; }
        this.messages.push(message);
        if (message.type === "session_snapshot") {
          this.snapshots.push(message);
          this.view = message.state.kind === "match" ? message.state.view : undefined;
        }
        if (message.type === "game_update" || message.type === "match_finished") this.view = message.view;
        if (message.type === "error") this.issues.push(`Backend rejected UI action: ${message.message}`);
      });
    });
  }

  async login(username: string) {
    await this.page.goto(this.url);
    await expect(this.page.getByRole("heading", { name: "Pixel Fleet", exact: true })).toBeVisible();
    await this.page.getByRole("textbox", { name: "Username" }).fill(username);
    const response = this.page.waitForResponse((response) => response.url() === `${this.url}/api/guest-login` && response.request().method() === "POST", { timeout: 10_000 });
    await this.page.getByRole("button", { name: "Start as guest", exact: true }).click();
    const login = await response;
    expect(login.status()).toBe(201);
    this.profile = (await login.json()).profile;
    await this.lobby(username);
    this.allowMissingSession = false;
  }

  async lobby(username = this.profile!.username) {
    await expect(this.page.getByRole("heading", { name: username, exact: true })).toBeVisible();
    await expect(this.page.getByRole("button", { name: "Start Game", exact: true })).toBeEnabled();
    await expect(this.page.getByRole("button", { name: "Cancel Search", exact: true })).toHaveCount(0);
    await expect(this.page.getByRole("button", { name: "Back to Lobby", exact: true })).toHaveCount(0);
    await expect(this.page.getByRole("region", { name: "Your placement", exact: true })).toHaveCount(0);
    await expect(this.page.getByRole("region", { name: "Target Grid", exact: true })).toHaveCount(0);
  }

  async disconnect() {
    const count = this.closed;
    await this.page.evaluate(() => {
      const sockets = (window as unknown as { __td08Sockets: WebSocket[] }).__td08Sockets;
      const socket = [...sockets].reverse().find((candidate) => candidate.readyState === WebSocket.OPEN);
      if (!socket) throw new Error("No live native WebSocket to disconnect");
      socket.close(1000, "TD-08 isolated connection loss");
    });
    await expect.poll(() => this.closed).toBeGreaterThan(count);
  }

  async snapshotAfter(count: number, kind: SessionSnapshot["state"]["kind"]) {
    await expect.poll(() => this.snapshots.length).toBeGreaterThan(count);
    expect(this.snapshots.at(-1)!.state.kind).toBe(kind);
  }

  async place(start = 0, end = fleet.length) {
    for (const ship of fleet.slice(start, end)) {
      await this.page.getByRole("button", { name: new RegExp(`^${ship.name} `) }).click();
      await this.page.getByRole("button", { name: `Tile ${letters[ship.x]}${ship.y + 1}`, exact: true }).click();
    }
  }

  async fire(target: Coordinate) {
    const button = this.page.getByRole("button", { name: `Target Grid ${letters[target.x]}${target.y + 1} unknown`, exact: true });
    await expect(this.page.getByText("Your Turn", { exact: true })).toBeVisible();
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => this.view?.enemyBoard.find((cell) => cell.x === target.x && cell.y === target.y)?.state).toMatch(/^(hit|miss|sunk)$/);
    const resolved = this.page.getByRole("button", { name: new RegExp(`^Target Grid ${letters[target.x]}${target.y + 1} (hit|miss|sunk)$`) });
    // The final shot unmounts the board and replaces it with the result screen.
    if (this.view!.phase !== "finished") {
      await expect(resolved).toBeVisible();
      await expect(resolved).toBeDisabled();
    }
  }
}

class BrowserGame {
  captains: Captain[] = [];
  disposal?: Promise<void>;
  constructor(readonly browser: Browser, readonly backend: Backend) {}
  async captain(username: string) {
    const context = await this.browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    // Test-side instrumentation only retains native sockets for close(). Every
    // frame still traverses Chromium's real socket and the real backend; no mocks,
    // fabricated messages, intercepted actions or production hooks are involved.
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      (window as unknown as { __td08Sockets: WebSocket[] }).__td08Sockets = sockets;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.push(this); }
      };
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const captain = new Captain(context, await context.newPage(), this.backend.url);
    this.captains.push(captain);
    await captain.login(username);
    return captain;
  }
  async pair() {
    const a = await this.captain("Browser Alice");
    const b = await this.captain("Browser Bob");
    await a.page.getByRole("button", { name: "Start Game", exact: true }).click();
    await expect(a.page.getByText("Searching for an opponent...", { exact: true })).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Cancel Search", exact: true })).toBeEnabled();
    await b.page.getByRole("button", { name: "Start Game", exact: true }).click();
    for (const captain of [a, b]) {
      await expect(captain.page.getByRole("region", { name: "Your placement", exact: true })).toBeVisible();
      await expect(captain.page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
    }
    expect(a.view!.matchId).toBe(b.view!.matchId);
    return [a, b] as const;
  }
  async playing(a: Captain, b: Captain) {
    await a.page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(a.page.getByText("Fleet confirmed. Waiting for the opponent to be ready.", { exact: true })).toBeVisible();
    await b.page.getByRole("button", { name: "Confirm", exact: true }).click();
    for (const captain of [a, b]) {
      await expect(captain.page.getByRole("region", { name: "Target Grid", exact: true })).toBeVisible();
      expect(captain.view!.phase).toBe("playing");
      await expect(captain.page.getByRole("button", { name: /^Target Grid [A-J][0-9]+ unknown$/ })).toHaveCount(100);
    }
  }
  async restart() {
    const counts = this.captains.map((captain) => captain.snapshots.length);
    this.captains.forEach((captain) => { captain.restarting = true; });
    try {
      await this.backend.stop();
      await this.backend.start(); // same database and the same port
      for (const [index, captain] of this.captains.entries()) {
        await captain.snapshotAfter(counts[index], "lobby");
        await captain.lobby();
      }
    } finally { this.captains.forEach((captain) => { captain.restarting = false; }); }
  }
  async artifacts(info: TestInfo) {
    for (const [index, captain] of this.captains.entries()) {
      const path = info.outputPath(`captain-${index + 1}.png`);
      await captain.page.screenshot({ path, fullPage: true }).then(() => info.attach(`Captain ${index + 1}`, { path, contentType: "image/png" })).catch(() => {});
      const trace = info.outputPath(`captain-${index + 1}-trace.zip`);
      await captain.context.tracing.stop({ path: trace }).then(() => info.attach(`Trace ${index + 1}`, { path: trace, contentType: "application/zip" })).catch(() => {});
    }
    await info.attach("Isolated backend and browser diagnostics", {
      body: `${this.backend.output}\n${JSON.stringify(this.captains.map((captain) => captain.issues))}`, contentType: "text/plain"
    });
  }
  dispose() {
    // Reentrant for fixture teardown and signals. Close browser contexts before
    // stopping the backend, then delete SQLite/WAL/SHM only after process exit.
    return this.disposal ??= (async () => {
      try {
        await Promise.all(this.captains.map((captain) => captain.context.close()));
      } finally {
        try { await this.backend.stop(); }
        finally { await rm(this.backend.directory, { recursive: true, force: true }); }
      }
    })();
  }
}

export const test = base.extend<{ game: BrowserGame }>({
  game: async ({ browser }, use, info) => {
    const directory = await mkdtemp(join(tmpdir(), "pixelfleet-browser-"));
    const game = new BrowserGame(browser, new Backend(directory));
    const interrupted = () => { void game.dispose().catch(() => {}); };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    let failed = false;
    try {
      await game.backend.start();
      await use(game);
      for (const captain of game.captains) expect(captain.issues, "Unexpected browser/backend diagnostics").toEqual([]);
    } catch (error) { failed = true; throw error; }
    finally {
      try {
        if (failed || info.status !== info.expectedStatus) await game.artifacts(info);
        else await Promise.all(game.captains.map((captain) => captain.context.tracing.stop()));
      } finally {
        try { await game.dispose(); }
        finally { process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted); }
      }
    }
  }
});
