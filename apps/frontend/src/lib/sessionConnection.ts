import { WS_PROTOCOL, type ClientMessage, type PlayerProfile, type ServerMessage, type SessionSnapshot } from "@pixelfleet/shared";
import { fetchMe, logoutGuest } from "./api";

interface Callbacks {
  profile: (profile: PlayerProfile | null) => void;
  loading: (loading: boolean) => void;
  connected: (connected: boolean) => void;
  reset: () => void;
  snapshot: (snapshot: SessionSnapshot) => void;
  message: (message: ServerMessage) => void;
  error: (message: string) => void;
}

interface Transport {
  fetchProfile: (signal: AbortSignal) => Promise<PlayerProfile | null>;
  logout: () => Promise<void>;
  openSocket: () => WebSocket;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
}

const browserTransport: Transport = {
  fetchProfile: fetchMe,
  logout: logoutGuest,
  openSocket: () => new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`, WS_PROTOCOL),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (timer) => window.clearTimeout(timer)
};

// Effect setup/cleanup own this lifecycle. Generation and socket identity are checked
// before callbacks can change React state, including events already queued at cleanup.
export class SessionConnection {
  private active = false;
  private generation = 0;
  private profile: PlayerProfile | null = null;
  private socket: WebSocket | null = null;
  private request: AbortController | null = null;
  private reconnectTimer: number | null = null;
  private logoutPending = false;
  private initialized = false;

  constructor(private readonly callbacks: Callbacks, private readonly transport: Transport = browserTransport) {}

  start(): void {
    this.active = true;
    this.invalidate();
    this.callbacks.connected(false);
    this.callbacks.loading(true);
    void this.refresh(this.generation);
  }

  stop(): void {
    this.active = false;
    this.invalidate();
  }

  loginHandler(): (profile: PlayerProfile) => void {
    const generation = this.generation;
    return (profile) => {
      if (this.isCurrent(generation)) this.setAccount(profile);
    };
  }

  send(message: ClientMessage): boolean {
    if (!this.active || !this.initialized || !this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async logout(): Promise<void> {
    if (!this.active || !this.profile || this.logoutPending) return;
    // Revoke local effects immediately, before the HTTP result or server close arrives.
    // Keep the displayed account until success; a failed request is not proof of logout.
    this.invalidate();
    const generation = this.generation;
    this.logoutPending = true;
    this.callbacks.connected(false);
    try {
      await this.transport.logout();
      if (this.isCurrent(generation)) this.setAccount(null);
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.logoutPending = false;
      this.callbacks.error(error instanceof Error ? error.message : "Logout failed.");
      // The server may have completed logout even when its response was lost.
      // A 401 ends the account; a network failure only schedules another retry.
      await this.refresh(generation);
    }
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private invalidate(): void {
    this.initialized = false;
    this.generation += 1;
    this.logoutPending = false;
    this.request?.abort();
    this.request = null;
    if (this.reconnectTimer !== null) this.transport.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private setAccount(profile: PlayerProfile | null): void {
    this.invalidate();
    this.profile = profile;
    this.callbacks.reset();
    this.callbacks.connected(false);
    this.callbacks.profile(profile);
    this.callbacks.loading(false);
    if (profile) this.connect(this.generation);
  }

  private async refresh(generation: number): Promise<void> {
    const request = new AbortController();
    this.request = request;
    try {
      const profile = await this.transport.fetchProfile(request.signal);
      if (!this.isCurrent(generation) || this.request !== request) return;
      this.request = null;
      if (!profile || profile.userId !== this.profile?.userId) {
        this.setAccount(profile);
      } else {
        this.profile = profile;
        this.callbacks.profile(profile);
        this.callbacks.loading(false);
        this.connect(generation);
      }
    } catch {
      if (!this.isCurrent(generation) || this.request !== request) return;
      this.request = null;
      this.callbacks.loading(false);
      if (this.profile) this.scheduleReconnect(generation);
    }
  }

  private connect(generation: number): void {
    if (!this.isCurrent(generation) || !this.profile) return;
    const ws = this.transport.openSocket();
    this.socket = ws;
    this.initialized = false;
    const current = () => this.isCurrent(generation) && this.socket === ws;
    ws.onmessage = (event) => {
      if (!current() || ws.readyState !== 1) return;
      let message: ServerMessage;
      try { message = JSON.parse(event.data) as ServerMessage; }
      catch { this.protocolFailure(ws); return; }
      if (message?.type === "session_snapshot") {
        const { profile, state } = message;
        if (!profile || typeof profile.userId !== "string" || !state ||
          !["lobby", "queue", "match"].includes(state.kind) ||
          (state.kind === "match" && (!state.view || state.view.you?.userId !== profile.userId ||
            typeof state.view.matchId !== "string" || !["placing", "playing", "saving", "save_failed", "finished"].includes(state.view.phase)))) {
          this.protocolFailure(ws); return;
        }
        if (profile.userId !== this.profile?.userId) {
          this.setAccount(profile);
          return;
        }
        this.profile = profile;
        this.callbacks.snapshot({ profile, state });
        this.initialized = true;
        this.callbacks.connected(true);
      } else if (!this.initialized) {
        this.protocolFailure(ws);
      } else if (message.type === "profile") {
        if (message.profile.userId !== this.profile?.userId) {
          this.setAccount(message.profile);
        } else {
          this.profile = message.profile;
          this.callbacks.profile(message.profile);
        }
      } else {
        this.callbacks.message(message);
      }
    };
    ws.onclose = (event) => {
      if (!current()) return;
      this.socket = null;
      this.initialized = false;
      this.callbacks.connected(false);
      if (event.code === 4003) { // GameHub.revokeSession
        this.setAccount(null);
      } else if (event.code === 4001) { // GameHub.connect replaced this connection
        this.callbacks.error("Another connection replaced this one.");
      } else if (event.code === 4002) {
        this.callbacks.error("Pixel Fleet was updated. Reload this page to reconnect.");
      } else {
        this.scheduleReconnect(generation);
      }
    };
  }

  private protocolFailure(ws: WebSocket): void {
    this.initialized = false;
    this.callbacks.connected(false);
    this.callbacks.error("Cannot initialize this connection. Reload this page to update Pixel Fleet.");
    ws.close(4002, "Snapshot required");
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrent(generation) || !this.profile) return;
    if (this.reconnectTimer !== null) this.transport.clearTimeout(this.reconnectTimer);
    const timer = this.transport.setTimeout(() => {
      if (!this.isCurrent(generation) || this.reconnectTimer !== timer) return;
      this.reconnectTimer = null;
      // Failed browser handshakes often expose only 1006, not HTTP 401.
      // Recheck the session so an expired cookie cannot cause an endless reconnect.
      void this.refresh(generation);
    }, 1200);
    this.reconnectTimer = timer;
  }
}
