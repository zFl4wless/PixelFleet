import { setImmediate as nextTurn } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerProfile, PublicMatchView, ServerMessage } from "@pixelfleet/shared";
import { fetchMe, logoutGuest } from "../apps/frontend/src/lib/api";
import { SessionConnection } from "../apps/frontend/src/lib/sessionConnection";

function profile(userId = "dummy-a", username = userId): PlayerProfile {
  return {
    userId, username, avatarSeed: userId, xp: 0, level: 1, xpIntoLevel: 0,
    xpForCurrentLevel: 0, xpForNextLevel: 100,
    stats: { wins: 0, losses: 0, gamesPlayed: 0, shotsFired: 0, hits: 0, shipsSunk: 0 }
  };
}

function match(matchId: string): PublicMatchView {
  return {
    matchId, phase: "placing", currentTurnUserId: null, ownBoard: [], enemyBoard: [], message: "Place ships.",
    you: { userId: "dummy-a", username: "Dummy", avatarSeed: "a", connected: true, ready: false },
    opponent: { userId: "dummy-opponent", username: "Opponent", avatarSeed: "b", connected: true, ready: false }
  };
}

// Browser transport double: close completion and already queued callbacks can be
// delivered after replacement. No listener, browser, database or network is used.
class ControlledSocket {
  readyState = 0;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  sent: unknown[] = [];
  closeCalls = 0;

  open() {
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, {} as Event);
  }
  message(message: ServerMessage) {
    this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(message) } as MessageEvent);
  }
  finishClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
  }
  close() {
    this.closeCalls += 1;
    this.readyState = 2;
  }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
}

interface PendingRequest {
  path: string;
  init: RequestInit;
  respond: (status: number, body: unknown) => void;
  reject: (error: Error) => void;
}

let requests: PendingRequest[];
let sessions: SessionConnection[];

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  sessions = [];
  vi.stubGlobal("fetch", vi.fn((path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({ path, init, respond: (status, body) => resolve(new Response(JSON.stringify(body), { status })), reject });
  })));
});

afterEach(() => {
  sessions.forEach((session) => session.stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => new Promise<void>((resolve) => nextTurn(resolve));

function fixture() {
  const state = {
    profile: null as PlayerProfile | null, loading: true, connected: false,
    queued: false, view: null as PublicMatchView | null, toasts: [] as string[]
  };
  const notifications: string[] = [];
  const sockets: ControlledSocket[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextTimer = 0;
  const session = new SessionConnection({
    profile: (value) => { state.profile = value; notifications.push("profile"); },
    loading: (value) => { state.loading = value; notifications.push("loading"); },
    connected: (value) => { state.connected = value; notifications.push("connected"); },
    reset: () => { state.queued = false; state.view = null; state.toasts = []; notifications.push("reset"); },
    message: (message) => {
      notifications.push("message");
      if (message.type === "queue_status") state.queued = message.queued;
      if (message.type === "game_update" || message.type === "match_finished") state.view = message.view;
      if (message.type === "toast" || message.type === "error") state.toasts.push(message.message);
    },
    error: (message) => { state.toasts.push(message); notifications.push("error"); }
  }, {
    fetchProfile: fetchMe,
    logout: logoutGuest,
    openSocket: () => {
      const socket = new ControlledSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      const id = ++nextTimer;
      handles.set(id, setTimeout(callback, delay));
      return id;
    },
    clearTimeout: (id) => { clearTimeout(handles.get(id)); handles.delete(id); }
  });
  sessions.push(session);
  return { session, state, sockets, timers, notifications };
}

async function loggedIn() {
  const f = fixture();
  f.session.start();
  requests.at(-1)!.respond(200, { profile: profile() });
  await flush();
  f.sockets[0].open();
  return f;
}

describe("frontend session lifecycle", () => {
  it("loads the authenticated profile, displays current events and sends actions on the open socket", async () => {
    const f = await loggedIn();
    expect(f.state).toMatchObject({ profile: profile(), loading: false, connected: true });
    f.sockets[0].message({ type: "profile", profile: profile("dummy-a", "Updated captain") });
    f.sockets[0].message({ type: "queue_status", queued: true, message: "Searching" });
    f.sockets[0].message({ type: "game_update", view: match("current-match") });
    expect(f.state.profile?.username).toBe("Updated captain");
    expect(f.state.queued).toBe(true);
    expect(f.state.view?.matchId).toBe("current-match");
    expect(f.sockets).toHaveLength(1);
    expect(f.session.send({ type: "cancel_queue" })).toBe(true);
    expect(f.sockets[0].sent).toEqual([{ type: "cancel_queue" }]);
  });

  it("ignores the first setup response across the Strict Mode setup-cleanup-setup lifecycle", async () => {
    const f = fixture();
    f.session.start();
    const old = requests[0];
    f.session.stop();
    f.session.start();
    expect(old.init.signal?.aborted).toBe(true);
    old.respond(200, { profile: profile("old-account") });
    await flush();
    expect(f.state.loading).toBe(true);
    expect(f.state.profile).toBeNull();
    expect(f.sockets).toHaveLength(0);
    requests[1].respond(401, { error: "Not logged in." });
    await flush();
    expect(f.state.loading).toBe(false);
    expect(f.state.profile).toBeNull();
  });

  it("ignores a late profile response and a duplicate old login completion after account selection", async () => {
    const f = fixture();
    f.session.start();
    const old = requests[0];
    const completeLogin = f.session.loginHandler();
    completeLogin(profile("new-account"));
    f.sockets[0].open();
    old.respond(200, { profile: profile("old-account") });
    completeLogin(profile("other-late-account"));
    await flush();
    expect(old.init.signal?.aborted).toBe(true);
    expect(f.state).toMatchObject({ profile: profile("new-account"), loading: false, connected: true });
    expect(f.sockets).toHaveLength(1);
  });

  it.each(["dummy-a", "dummy-b"])("rejects old socket events after selecting account %s, including a new generation of the same account", async (userId) => {
    const f = await loggedIn();
    const old = f.sockets[0];
    old.message({ type: "game_update", view: match("old-match") });
    old.message({ type: "queue_status", queued: true, message: "Searching" });
    f.session.loginHandler()(profile(userId));
    const current = f.sockets[1];
    expect(old.closeCalls).toBe(1);
    expect(f.state.view).toBeNull();
    expect(f.state.queued).toBe(false);
    current.open();
    current.message({ type: "game_update", view: match("new-match") });
    const before = structuredClone(f.state);
    old.open();
    old.message({ type: "profile", profile: profile("old-account") });
    old.message({ type: "game_update", view: match("late-old-match") });
    old.message({ type: "queue_status", queued: true, message: "Searching" });
    old.message({ type: "toast", tone: "danger", message: "Old toast" });
    old.finishClose(4003);
    old.finishClose(1006);
    vi.advanceTimersByTime(10_000);
    expect(f.state).toEqual(before);
    expect(f.session.send({ type: "join_queue" })).toBe(true);
    expect(old.sent).toEqual([]);
    expect(current.sent).toEqual([{ type: "join_queue" }]);
    expect(f.sockets).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it("does not process messages or send actions once the current socket is closing", async () => {
    const f = await loggedIn();
    f.sockets[0].readyState = 2;
    f.sockets[0].message({ type: "game_update", view: match("closing-match") });
    expect(f.state.view).toBeNull();
    expect(f.session.send({ type: "join_queue" })).toBe(false);
    expect(f.sockets[0].sent).toEqual([]);
  });

  it.each([1006, 1012, 4009])("reconnects after allowed close %s, retaining game state and ignoring old callbacks", async (code) => {
    const f = await loggedIn();
    const old = f.sockets[0];
    old.message({ type: "game_update", view: match("retained-match") });
    old.finishClose(code);
    expect(f.state.connected).toBe(false);
    expect(f.state.profile).toEqual(profile());
    expect(f.state.view?.matchId).toBe("retained-match");
    expect(f.session.send({ type: "join_queue" })).toBe(false);
    expect(f.timers[0].delay).toBe(1200);
    vi.advanceTimersByTime(1199);
    expect(requests).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(requests[1].path).toBe("/api/me");
    requests[1].respond(200, { profile: profile("dummy-a", "Recovered captain") });
    await flush();
    const current = f.sockets[1];
    current.open();
    const before = structuredClone(f.state);
    old.finishClose(1006);
    old.message({ type: "game_update", view: match("stale-match") });
    f.timers[0].callback(); // already delivered/cancelled timer must not run twice
    vi.advanceTimersByTime(5000);
    expect(f.state).toEqual(before);
    expect(requests).toHaveLength(2);
    expect(f.sockets).toHaveLength(2);
  });

  it("retries network failures without treating them as session revocation", async () => {
    const f = await loggedIn();
    f.sockets[0].message({ type: "game_update", view: match("retained-match") });
    f.sockets[0].finishClose();
    vi.advanceTimersByTime(1200);
    requests[1].reject(new TypeError("Dummy network outage"));
    await flush();
    expect(f.state.profile).toEqual(profile());
    expect(f.state.view?.matchId).toBe("retained-match");
    expect(f.state.connected).toBe(false);
    vi.advanceTimersByTime(1200);
    requests[2].respond(200, { profile: profile() });
    await flush();
    f.sockets[1].open();
    expect(f.state.connected).toBe(true);
  });

  it("ends the account when a reconnect profile check proves the session missing", async () => {
    const f = await loggedIn();
    f.sockets[0].message({ type: "game_update", view: match("old-match") });
    f.sockets[0].message({ type: "queue_status", queued: true, message: "Searching" });
    f.sockets[0].finishClose();
    vi.advanceTimersByTime(1200);
    requests[1].respond(401, { error: "Not logged in." });
    await flush();
    expect(f.state).toMatchObject({ profile: null, loading: false, connected: false, queued: false, view: null });
    vi.advanceTimersByTime(10_000);
    expect(requests).toHaveLength(2);
    expect(f.sockets).toHaveLength(1);
  });

  it("goes to login immediately on session revocation, ignoring late login and socket callbacks", async () => {
    const f = await loggedIn();
    const oldLogin = f.session.loginHandler();
    const old = f.sockets[0];
    old.message({ type: "game_update", view: match("old-match") });
    old.finishClose(4003);
    expect(f.state).toMatchObject({ profile: null, loading: false, connected: false, view: null });
    oldLogin(profile());
    old.open();
    old.message({ type: "profile", profile: profile() });
    old.finishClose();
    vi.advanceTimersByTime(10_000);
    expect(f.state.profile).toBeNull();
    expect(requests).toHaveLength(1);
    expect(f.sockets).toHaveLength(1);
  });

  it("does not compete with a server-side replacement by starting automatic reconnects", async () => {
    const f = await loggedIn();
    f.sockets[0].finishClose(4001);
    expect(f.state.profile).toEqual(profile());
    expect(f.state.connected).toBe(false);
    expect(f.state.toasts).toEqual(["Another connection replaced this one."]);
    vi.advanceTimersByTime(10_000);
    expect(requests).toHaveLength(1);
    expect(f.sockets).toHaveLength(1);
  });

  it("invalidates effects immediately at logout and clears the account only after success", async () => {
    const f = await loggedIn();
    const old = f.sockets[0];
    const logout = f.session.logout();
    await f.session.logout(); // duplicate while pending must not issue another request
    expect(f.state.profile).toEqual(profile());
    expect(f.state.connected).toBe(false);
    expect(f.session.send({ type: "join_queue" })).toBe(false);
    expect(requests[1]).toMatchObject({ path: "/api/logout", init: { method: "POST", credentials: "include" } });
    expect(requests).toHaveLength(2);
    old.open();
    old.message({ type: "profile", profile: profile("stale-account") });
    old.message({ type: "game_update", view: match("stale-match") });
    old.finishClose(4003);
    old.finishClose(1006);
    expect(f.state.profile).toEqual(profile());
    expect(f.state.view).toBeNull();
    requests[1].respond(200, { ok: true });
    await logout;
    expect(f.state).toMatchObject({ profile: null, connected: false, loading: false, queued: false, view: null });
    vi.advanceTimersByTime(10_000);
    expect(f.sockets).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });

  it("keeps a valid account on failed logout, reports the error and uses a fresh connection", async () => {
    const f = await loggedIn();
    const old = f.sockets[0];
    const logout = f.session.logout();
    requests[1].respond(503, { error: "Dummy logout failure" });
    await flush();
    expect(f.state.profile).toEqual(profile());
    expect(f.state.toasts).toContain("Dummy logout failure");
    requests[2].respond(200, { profile: profile() });
    await logout;
    f.sockets[1].open();
    old.finishClose(4003);
    expect(f.state.connected).toBe(true);
    expect(f.state.profile).toEqual(profile());
    expect(f.session.send({ type: "join_queue" })).toBe(true);
    expect(old.sent).toEqual([]);
    expect(f.sockets[1].sent).toEqual([{ type: "join_queue" }]);
  });

  it("goes to login when a lost logout response is followed by a missing session", async () => {
    const f = await loggedIn();
    const logout = f.session.logout();
    requests[1].reject(new TypeError("Dummy response lost"));
    await flush();
    requests[2].respond(401, { error: "Not logged in." });
    await logout;
    expect(f.state).toMatchObject({ profile: null, loading: false, connected: false });
    vi.advanceTimersByTime(10_000);
    expect(requests).toHaveLength(3);
    expect(f.sockets).toHaveLength(1);
  });

  it("does not claim logout success if both logout and revalidation encounter network failures", async () => {
    const f = await loggedIn();
    const logout = f.session.logout();
    requests[1].reject(new TypeError("Dummy offline logout"));
    await flush();
    requests[2].reject(new TypeError("Dummy offline profile"));
    await logout;
    expect(f.state.profile).toEqual(profile());
    expect(f.state.connected).toBe(false);
    vi.advanceTimersByTime(1200);
    requests[3].respond(401, { error: "Not logged in." });
    await flush();
    expect(f.state.profile).toBeNull();
  });

  it.each(["success", "failure"])("ignores late logout %s after account replacement", async (result) => {
    const f = await loggedIn();
    const logout = f.session.logout();
    f.session.loginHandler()(profile("new-account"));
    f.sockets[1].open();
    f.sockets[1].message({ type: "game_update", view: match("new-match") });
    const before = structuredClone(f.state);
    if (result === "success") requests[1].respond(200, { ok: true });
    else requests[1].reject(new TypeError("Old logout failed"));
    await logout;
    expect(f.state).toEqual(before);
    expect(requests).toHaveLength(2);
  });

  it("ignores an already queued reconnect timer after logout, even if its callback is delivered", async () => {
    const f = await loggedIn();
    f.sockets[0].finishClose();
    const logout = f.session.logout();
    f.timers[0].callback();
    vi.advanceTimersByTime(5000);
    expect(requests).toHaveLength(2);
    requests[1].respond(200, { ok: true });
    await logout;
    expect(f.state.profile).toBeNull();
    expect(f.sockets).toHaveLength(1);
  });

  it("ignores an in-flight reconnect profile response after account replacement", async () => {
    const f = await loggedIn();
    f.sockets[0].finishClose();
    vi.advanceTimersByTime(1200);
    const pending = requests[1];
    f.session.loginHandler()(profile("new-account"));
    f.sockets[1].open();
    pending.respond(200, { profile: profile("old-account") });
    await flush();
    expect(pending.init.signal?.aborted).toBe(true);
    expect(f.state).toMatchObject({ profile: profile("new-account"), connected: true });
    expect(f.sockets).toHaveLength(2);
  });

  it("prevents an in-flight reconnect response from restoring the account during logout", async () => {
    const f = await loggedIn();
    f.sockets[0].finishClose();
    vi.advanceTimersByTime(1200);
    const pending = requests[1];
    const logout = f.session.logout();
    pending.respond(200, { profile: profile("late-account") });
    await flush();
    expect(pending.init.signal?.aborted).toBe(true);
    expect(f.state.profile).toEqual(profile());
    expect(f.state.connected).toBe(false);
    expect(f.sockets).toHaveLength(1);
    requests[2].respond(200, { ok: true });
    await logout;
    expect(f.state.profile).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(requests).toHaveLength(3);
  });

  it("treats a different account reported by the current authenticated socket as an account boundary", async () => {
    const f = await loggedIn();
    const old = f.sockets[0];
    old.message({ type: "game_update", view: match("old-match") });
    old.message({ type: "queue_status", queued: true, message: "Searching" });
    old.message({ type: "profile", profile: profile("new-account") });
    expect(f.state).toMatchObject({ profile: profile("new-account"), connected: false, queued: false, view: null });
    expect(old.closeCalls).toBe(1);
    f.sockets[1].open();
    old.open();
    old.message({ type: "profile", profile: profile("old-account") });
    old.finishClose(4003);
    expect(f.state.profile?.userId).toBe("new-account");
    expect(f.state.connected).toBe(true);
    expect(f.sockets).toHaveLength(2);
  });

  it("cleans up pending work and ignores events across cleanup and a new effect setup", async () => {
    const f = await loggedIn();
    const old = f.sockets[0];
    old.finishClose();
    const queuedTimer = f.timers[0];
    vi.advanceTimersByTime(1200);
    const pending = requests[1];
    f.session.stop();
    const notifications = f.notifications.length;
    pending.reject(new TypeError("Late old request failure"));
    queuedTimer.callback();
    old.open();
    old.message({ type: "game_update", view: match("late-match") });
    old.finishClose(4003);
    await flush();
    expect(f.notifications).toHaveLength(notifications);
    expect(pending.init.signal?.aborted).toBe(true);
    f.session.start();
    requests[2].respond(200, { profile: profile() });
    await flush();
    f.sockets[1].open();
    old.finishClose();
    queuedTimer.callback();
    vi.advanceTimersByTime(10_000);
    expect(f.state.connected).toBe(true);
    expect(f.sockets).toHaveLength(2);
    expect(requests).toHaveLength(3);
  });

  it("resets account-specific game state if the authenticated reconnect belongs to a different account", async () => {
    const f = await loggedIn();
    f.sockets[0].message({ type: "game_update", view: match("old-match") });
    f.sockets[0].finishClose();
    vi.advanceTimersByTime(1200);
    requests[1].respond(200, { profile: profile("new-account") });
    await flush();
    f.sockets[1].open();
    expect(f.state).toMatchObject({ profile: profile("new-account"), view: null, queued: false, connected: true });
  });
});

describe("profile request authentication semantics", () => {
  it("passes an abort signal and included credentials and treats only 401 as a missing session", async () => {
    const controller = new AbortController();
    const pending = fetchMe(controller.signal);
    expect(requests[0]).toMatchObject({ path: "/api/me", init: { signal: controller.signal, credentials: "include" } });
    requests[0].respond(401, { error: "Not logged in." });
    expect(await pending).toBeNull();
  });

  it.each([403, 503])("preserves HTTP %s as an error instead of claiming session revocation", async (status) => {
    const result = expect(fetchMe()).rejects.toThrow("Dummy HTTP failure");
    requests[0].respond(status, { error: "Dummy HTTP failure" });
    await result;
  });

  it("preserves network and abort failures instead of claiming session revocation", async () => {
    for (const error of [new TypeError("Dummy network failure"), new DOMException("Dummy abort", "AbortError")]) {
      const result = expect(fetchMe()).rejects.toBe(error);
      requests.at(-1)!.reject(error);
      await result;
    }
  });
});
