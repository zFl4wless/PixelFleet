import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  applyShot,
  BOARD_SIZE,
  coordinateKey,
  isInsideBoard,
  isShipSunk,
  type ClientMessage,
  type Coordinate,
  type MatchId,
  type MatchPlayerPublic,
  type MatchResult,
  type PlacedShip,
  type PlayerProfile,
  type PublicCell,
  type PublicMatchView,
  type ServerMessage,
  type ShipPlacement,
  type ShotOutcome,
  validateFleet
} from "@pixelfleet/shared";
import { getProfile, updateStatsAfterMatch } from "./db.js";
import { metrics } from "./metrics.js";
import { FixedWindowRateLimiter, parseEnvInt } from "./rate-limit.js";

const RECONNECT_GRACE_MS = 30_000;
const MAX_WS_PAYLOAD_BYTES = parseEnvInt("MAX_WS_PAYLOAD_BYTES", 4096);

interface ClientConnection {
  userId: string;
  ws: WebSocket;
  profile: PlayerProfile;
  ip: string;
  sessionId: string;
  revoked: boolean;
}

interface MatchPlayerState {
  userId: string;
  username: string;
  avatarSeed: string;
  connected: boolean;
  ready: boolean;
  ships: PlacedShip[];
  shots: Map<string, ShotOutcome>;
  shotsFired: number;
  hits: number;
  shipsSunk: number;
  disconnectDeadline?: number;
}

interface MatchState {
  id: MatchId;
  players: [MatchPlayerState, MatchPlayerState];
  phase: "placing" | "playing" | "finished";
  currentTurnUserId: string | null;
  results: Map<string, MatchResult>;
  leftAfterFinish: Set<string>;
  reconnectTimers: Map<string, NodeJS.Timeout>;
}

export interface HubStats {
  activeConnections: number;
  queuedPlayers: number;
  matches: number;
  placingMatches: number;
  playingMatches: number;
  finishedMatches: number;
}

interface ClientContext {
  ip: string;
  sessionId: string;
}

export class GameHub {
  private readonly connections = new Map<string, ClientConnection>();
  private readonly queue: string[] = [];
  private readonly matches = new Map<string, MatchState>();
  private readonly messageLimiter = new FixedWindowRateLimiter({
    limit: parseEnvInt("WS_MESSAGES_PER_10S", 120),
    windowMs: 10_000
  });
  private readonly queueLimiter = new FixedWindowRateLimiter({
    limit: parseEnvInt("QUEUE_ACTIONS_PER_MINUTE", 12),
    windowMs: 60_000
  });
  private readonly fireLimiter = new FixedWindowRateLimiter({
    limit: parseEnvInt("FIRE_ACTIONS_PER_10S", 120),
    windowMs: 10_000
  });
  private readonly invalidActionCounts = new Map<string, number>();

  connect(ws: WebSocket, profile: PlayerProfile, context: ClientContext): void {
    const existing = this.connections.get(profile.userId);
    if (existing) {
      existing.revoked = true;
    }

    const connection: ClientConnection = { userId: profile.userId, ws, profile, ...context, revoked: false };
    this.connections.set(profile.userId, connection);
    // Also clean up if connection initialization fails before message handlers are installed.
    ws.on("close", () => this.disconnect(connection));
    if (existing && existing.ws !== ws) {
      existing.ws.close(4001, "New connection opened");
    }
    metrics.inc("ws_connections_accepted_total");
    this.send(profile.userId, { type: "profile", profile });

    const match = this.findMatchForUser(profile.userId);
    if (match && match.phase !== "finished") {
      const player = this.getPlayer(match, profile.userId);
      player.connected = true;
      player.disconnectDeadline = undefined;
      const timer = match.reconnectTimers.get(profile.userId);
      if (timer) {
        clearTimeout(timer);
        match.reconnectTimers.delete(profile.userId);
      }
      this.broadcastGameUpdate(match, "Opponent reconnected.");
    } else if (this.queue.includes(profile.userId)) {
      this.send(profile.userId, { type: "queue_status", queued: true, message: "Searching for an opponent..." });
    }

    ws.on("message", (payload) => {
      if (this.isCurrentConnection(connection)) {
        this.handleMessage(connection, payload.toString());
      }
    });
  }

  private isCurrentConnection(connection: ClientConnection): boolean {
    return !connection.revoked && connection.ws.readyState === WebSocket.OPEN &&
      this.connections.get(connection.userId) === connection;
  }

  revokeSession(sessionId: string): void {
    const connections = [...this.connections.values()].filter((connection) => connection.sessionId === sessionId);
    for (const connection of connections) {
      connection.revoked = true;
    }
    for (const connection of connections) {
      this.disconnect(connection);
      connection.ws.close(4003, "Session revoked");
    }
  }

  private disconnect(connection: ClientConnection): void {
    connection.revoked = true;
    const { userId } = connection;
    if (this.connections.get(userId) !== connection) {
      return;
    }

    this.connections.delete(userId);
    this.removeFromQueue(userId);

    const match = this.findMatchForUser(userId);
    if (!match) {
      return;
    }

    if (match.phase === "finished") {
      match.leftAfterFinish.add(userId);
      if (match.leftAfterFinish.size === match.players.length) {
        this.matches.delete(match.id);
      }
      return;
    }

    const player = this.getPlayer(match, userId);
    player.connected = false;
    player.disconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
    this.broadcastGameUpdate(match, "A player is offline. Reconnect window is active.");

    const timer = setTimeout(() => {
      const freshMatch = this.matches.get(match.id);
      if (!freshMatch || freshMatch.phase === "finished") {
        return;
      }

      const disconnected = this.getPlayer(freshMatch, userId);
      if (!disconnected.connected) {
        const winner = this.getOpponent(freshMatch, userId);
        this.finishMatch(freshMatch, winner.userId, "forfeit");
      }
    }, RECONNECT_GRACE_MS);

    match.reconnectTimers.set(userId, timer);
  }

  private handleMessage(connection: ClientConnection, raw: string): void {
    const { userId } = connection;
    metrics.inc("ws_messages_total");

    if (Buffer.byteLength(raw, "utf8") > MAX_WS_PAYLOAD_BYTES) {
      this.rejectAction(connection, "Message payload is too large.", true);
      return;
    }

    const messageLimit = this.messageLimiter.check(userId);
    if (!messageLimit.allowed) {
      this.rejectAction(connection, "Slow down. You are sending too many actions.", true);
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.rejectAction(connection, "Invalid message.");
      return;
    }

    try {
      this.validateClientMessage(message);
      switch (message.type) {
        case "join_queue":
          this.assertActionAllowed(this.queueLimiter, userId, "Too many queue actions. Try again shortly.");
          this.joinQueue(userId);
          break;
        case "cancel_queue":
          this.assertActionAllowed(this.queueLimiter, userId, "Too many queue actions. Try again shortly.");
          this.cancelQueue(userId);
          break;
        case "place_ships":
          this.placeShips(userId, message.placements);
          break;
        case "fire":
          this.assertActionAllowed(this.fireLimiter, userId, "Too many fire actions. Wait a moment.");
          this.fire(userId, { x: message.x, y: message.y });
          break;
        case "leave_match":
          this.leaveMatch(userId);
          break;
        default:
          this.rejectAction(connection, "Unknown action.");
      }
    } catch (error) {
      this.rejectAction(connection, error instanceof Error ? error.message : "Action rejected.");
    }
  }

  private joinQueue(userId: string): void {
    const activeMatch = this.findMatchForUser(userId);
    if (activeMatch && activeMatch.phase !== "finished") {
      this.sendError(userId, "You are already in a match.");
      return;
    }

    if (this.queue.includes(userId)) {
      this.send(userId, { type: "queue_status", queued: true, message: "Searching for an opponent..." });
      return;
    }

    const opponentId = this.queue.find((queuedId) => queuedId !== userId && this.connections.has(queuedId));
    if (!opponentId) {
      this.queue.push(userId);
      this.send(userId, { type: "queue_status", queued: true, message: "Searching for an opponent..." });
      return;
    }

    this.removeFromQueue(opponentId);
    this.createMatch(userId, opponentId);
  }

  private cancelQueue(userId: string): void {
    this.removeFromQueue(userId);
    this.send(userId, { type: "queue_status", queued: false, message: "Back in the lobby." });
  }

  private createMatch(userA: string, userB: string): void {
    const profileA = getProfile(userA);
    const profileB = getProfile(userB);
    if (!profileA || !profileB) {
      throw new Error("Player profile not found.");
    }

    const match: MatchState = {
      id: randomUUID(),
      players: [this.createMatchPlayer(profileA), this.createMatchPlayer(profileB)],
      phase: "placing",
      currentTurnUserId: null,
      results: new Map(),
      leftAfterFinish: new Set(),
      reconnectTimers: new Map()
    };

    this.matches.set(match.id, match);
    metrics.inc("matches_created_total");
    this.send(userA, { type: "queue_status", queued: false, message: "Match found!" });
    this.send(userB, { type: "queue_status", queued: false, message: "Match found!" });
    this.send(userA, { type: "match_found", matchId: match.id });
    this.send(userB, { type: "match_found", matchId: match.id });
    this.broadcastGameUpdate(match, "Match found. Place your fleet.");
  }

  private createMatchPlayer(profile: PlayerProfile): MatchPlayerState {
    return {
      userId: profile.userId,
      username: profile.username,
      avatarSeed: profile.avatarSeed,
      connected: true,
      ready: false,
      ships: [],
      shots: new Map(),
      shotsFired: 0,
      hits: 0,
      shipsSunk: 0
    };
  }

  private placeShips(userId: string, placements: ShipPlacement[]): void {
    const match = this.requireActiveMatch(userId);
    if (match.phase !== "placing") {
      throw new Error("The placement phase is over.");
    }

    const player = this.getPlayer(match, userId);
    if (player.ready) {
      throw new Error("Your fleet is already confirmed.");
    }

    const validation = validateFleet(placements);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    player.ships = validation.ships;
    player.ready = true;

    if (match.players.every((candidate) => candidate.ready)) {
      match.phase = "playing";
      match.currentTurnUserId = match.players[Math.floor(Math.random() * match.players.length)].userId;
      this.broadcastGameUpdate(match, "Both fleets are ready. Fire away!");
      return;
    }

    this.broadcastGameUpdate(match, "Fleet confirmed. Waiting for the opponent.");
  }

  private fire(userId: string, target: Coordinate): void {
    const match = this.requireActiveMatch(userId);
    if (match.phase !== "playing") {
      throw new Error("The match is not running yet.");
    }
    if (match.currentTurnUserId !== userId) {
      throw new Error("It is not your turn.");
    }
    if (!isInsideBoard(target)) {
      throw new Error("Shot is outside the board.");
    }

    const shooter = this.getPlayer(match, userId);
    const opponent = this.getOpponent(match, userId);
    const key = coordinateKey(target);

    if (shooter.shots.has(key)) {
      throw new Error("This tile has already been targeted.");
    }

    const previousShots = new Set(shooter.shots.keys());
    const outcome = applyShot(opponent.ships, target, previousShots);
    shooter.shots.set(key, outcome);
    shooter.shotsFired += 1;

    if (outcome.hit) {
      shooter.hits += 1;
    }
    if (outcome.sunkShipId) {
      shooter.shipsSunk += 1;
    }

    if (outcome.gameOver) {
      this.finishMatch(match, userId, "ships_sunk");
      return;
    }

    match.currentTurnUserId = opponent.userId;
    const message = outcome.hit
      ? outcome.sunkShipId
        ? `${shooter.username} sunk a ship!`
        : `${shooter.username} hits!`
      : `${shooter.username} misses.`;
    this.broadcastGameUpdate(match, message);
  }

  private finishMatch(match: MatchState, winnerId: string, reason: "ships_sunk" | "forfeit"): void {
    if (match.phase === "finished") {
      return;
    }

    match.phase = "finished";
    match.currentTurnUserId = null;
    metrics.inc("matches_finished_total");

    for (const timer of match.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    match.reconnectTimers.clear();

    for (const player of match.players) {
      const won = player.userId === winnerId;
      const update = updateStatsAfterMatch(player.userId, {
        won,
        hits: player.hits,
        shipsSunk: player.shipsSunk,
        shotsFired: player.shotsFired
      });

      match.results.set(player.userId, {
        winnerId,
        reason,
        xpEarned: update.xpEarned,
        won,
        profile: update.profile
      });

      this.send(player.userId, { type: "profile", profile: update.profile });
    }

    for (const player of match.players) {
      this.send(player.userId, { type: "match_finished", view: this.createView(match, player.userId) });
    }
  }

  private leaveMatch(userId: string): void {
    const match = this.findMatchForUser(userId);
    if (!match) {
      return;
    }

    if (match.phase !== "finished") {
      const opponent = this.getOpponent(match, userId);
      this.finishMatch(match, opponent.userId, "forfeit");
      return;
    }

    match.leftAfterFinish.add(userId);
    const profile = getProfile(userId);
    if (profile) {
      this.send(userId, { type: "profile", profile });
    }

    if (match.leftAfterFinish.size === match.players.length) {
      this.matches.delete(match.id);
    }
  }

  private requireActiveMatch(userId: string): MatchState {
    const match = this.findMatchForUser(userId);
    if (!match || match.phase === "finished") {
      throw new Error("No active match found.");
    }
    return match;
  }

  private findMatchForUser(userId: string): MatchState | null {
    for (const match of this.matches.values()) {
      if (match.players.some((player) => player.userId === userId) && !match.leftAfterFinish.has(userId)) {
        return match;
      }
    }
    return null;
  }

  private getPlayer(match: MatchState, userId: string): MatchPlayerState {
    const player = match.players.find((candidate) => candidate.userId === userId);
    if (!player) {
      throw new Error("Player is not in the match.");
    }
    return player;
  }

  private getOpponent(match: MatchState, userId: string): MatchPlayerState {
    const opponent = match.players.find((candidate) => candidate.userId !== userId);
    if (!opponent) {
      throw new Error("Opponent not found.");
    }
    return opponent;
  }

  private removeFromQueue(userId: string): void {
    const index = this.queue.indexOf(userId);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private createView(match: MatchState, userId: string, overrideMessage?: string): PublicMatchView {
    const you = this.getPlayer(match, userId);
    const opponent = this.getOpponent(match, userId);
    const result = match.results.get(userId);

    return {
      matchId: match.id,
      phase: match.phase,
      you: this.toPublicPlayer(you),
      opponent: this.toPublicPlayer(opponent),
      currentTurnUserId: match.currentTurnUserId,
      ownBoard: this.createOwnBoard(you, opponent),
      enemyBoard: this.createEnemyBoard(you, opponent),
      message: overrideMessage ?? this.defaultMessage(match, userId),
      result,
      reconnectDeadline: opponent.disconnectDeadline
    };
  }

  private defaultMessage(match: MatchState, userId: string): string {
    if (match.phase === "placing") {
      const you = this.getPlayer(match, userId);
      return you.ready ? "Fleet confirmed. Waiting for the opponent." : "Place your fleet.";
    }

    if (match.phase === "playing") {
      return match.currentTurnUserId === userId ? "Your turn." : "Opponent's turn.";
    }

    const result = match.results.get(userId);
    if (!result) {
      return "Match finished.";
    }
    return result.won ? "Victory!" : "Defeat.";
  }

  private toPublicPlayer(player: MatchPlayerState): MatchPlayerPublic {
    return {
      userId: player.userId,
      username: player.username,
      avatarSeed: player.avatarSeed,
      connected: player.connected,
      ready: player.ready
    };
  }

  private createOwnBoard(player: MatchPlayerState, opponent: MatchPlayerState): PublicCell[] {
    return this.allCells().map((cell) => {
      const key = coordinateKey(cell);
      const ship = player.ships.find((candidate) => candidate.cells.some((shipCell) => coordinateKey(shipCell) === key));
      const incomingShot = opponent.shots.get(key);

      if (incomingShot?.hit && ship) {
        return { ...cell, state: isShipSunk(ship) ? "sunk" : "hit", shipId: ship.id };
      }
      if (incomingShot && !incomingShot.hit) {
        return { ...cell, state: "miss" };
      }
      if (ship) {
        return { ...cell, state: "ship", shipId: ship.id };
      }
      return { ...cell, state: "water" };
    });
  }

  private createEnemyBoard(player: MatchPlayerState, opponent: MatchPlayerState): PublicCell[] {
    return this.allCells().map((cell) => {
      const shot = player.shots.get(coordinateKey(cell));
      if (!shot) {
        return { ...cell, state: "unknown" };
      }

      if (!shot.hit) {
        return { ...cell, state: "miss" };
      }

      const ship = opponent.ships.find((candidate) =>
        candidate.cells.some((shipCell) => coordinateKey(shipCell) === coordinateKey(cell))
      );

      if (ship && isShipSunk(ship)) {
        return { ...cell, state: "sunk", shipId: ship.id };
      }

      return { ...cell, state: "hit" };
    });
  }

  private allCells(): Coordinate[] {
    const cells: Coordinate[] = [];
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        cells.push({ x, y });
      }
    }
    return cells;
  }

  private broadcastGameUpdate(match: MatchState, message?: string): void {
    for (const player of match.players) {
      this.send(player.userId, { type: "game_update", view: this.createView(match, player.userId, message) });
    }
  }

  private sendError(userId: string, message: string): void {
    this.send(userId, { type: "error", message });
    this.send(userId, { type: "toast", tone: "danger", message });
  }

  private rejectAction(connection: ClientConnection, message: string, closeConnection = false): void {
    if (!this.isCurrentConnection(connection)) {
      return;
    }
    const { userId } = connection;
    metrics.inc("ws_messages_rejected_total");
    metrics.event("security", `Rejected action for user ${userId}: ${message}`);
    this.sendError(userId, message);

    const invalidCount = (this.invalidActionCounts.get(userId) ?? 0) + 1;
    this.invalidActionCounts.set(userId, invalidCount);

    if (closeConnection || invalidCount >= 8) {
      connection.ws.close(4008, "Too many invalid actions");
    }
  }

  private assertActionAllowed(limiter: FixedWindowRateLimiter, key: string, message: string): void {
    const result = limiter.check(key);
    if (!result.allowed) {
      metrics.inc("rate_limited_total");
      throw new Error(message);
    }
  }

  private validateClientMessage(message: ClientMessage): void {
    if (!message || typeof message !== "object" || !("type" in message)) {
      throw new Error("Invalid message.");
    }

    if (message.type === "fire") {
      if (!Number.isInteger(message.x) || !Number.isInteger(message.y) || !isInsideBoard({ x: message.x, y: message.y })) {
        throw new Error("Invalid target tile.");
      }
      return;
    }

    if (message.type === "place_ships") {
      if (!Array.isArray(message.placements) || message.placements.length > 5) {
        throw new Error("Invalid ship placement payload.");
      }

      for (const placement of message.placements) {
        if (
          typeof placement !== "object" ||
          !placement ||
          !Number.isInteger(placement.x) ||
          !Number.isInteger(placement.y) ||
          (placement.orientation !== "horizontal" && placement.orientation !== "vertical")
        ) {
          throw new Error("Invalid ship placement payload.");
        }
      }
    }
  }

  private send(userId: string, message: ServerMessage): void {
    const connection = this.connections.get(userId);
    if (!connection || !this.isCurrentConnection(connection)) {
      return;
    }
    connection.ws.send(JSON.stringify(message));
  }

  stats(): HubStats {
    const matches = Array.from(this.matches.values());
    return {
      activeConnections: this.connections.size,
      queuedPlayers: this.queue.length,
      matches: matches.length,
      placingMatches: matches.filter((match) => match.phase === "placing").length,
      playingMatches: matches.filter((match) => match.phase === "playing").length,
      finishedMatches: matches.filter((match) => match.phase === "finished").length
    };
  }

  resetRuntime(closeCode = 4009, closeReason = "Admin reset"): HubStats {
    const connections = [...this.connections.values()];
    for (const connection of connections) {
      connection.revoked = true;
    }
    for (const match of this.matches.values()) {
      for (const timer of match.reconnectTimers.values()) {
        clearTimeout(timer);
      }
    }

    this.connections.clear();
    this.queue.length = 0;
    this.matches.clear();
    this.messageLimiter.reset();
    this.queueLimiter.reset();
    this.fireLimiter.reset();
    this.invalidActionCounts.clear();
    for (const connection of connections) {
      connection.ws.close(closeCode, closeReason);
    }
    return this.stats();
  }
}
