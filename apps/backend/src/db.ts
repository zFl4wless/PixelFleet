import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { sessionExpiresAt } from "./session-lifetime.js";
import { inTransaction, migrateDatabase } from "./migrations.js";
import { PublicInputError } from "./input-errors.js";
import {
  calculateMatchXp,
  hitRate,
  type MatchRewards,
  type PlayerProfile,
  type PlayerStats,
  xpProgress
} from "@pixelfleet/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DATABASE_PATH ?? join(__dirname, "../data/pixelfleet.sqlite");

interface UserRow {
  user_id: string;
  username: string;
  avatar_seed: string;
  xp: number;
  wins: number;
  losses: number;
  games_played: number;
  shots_fired: number;
  hits: number;
  ships_sunk: number;
}

export interface DatabaseStats {
  users: number;
  sessions: number;
  totalXp: number;
  totalGamesPlayed: number;
  totalShotsFired: number;
  totalHits: number;
}

export type ResetScope = "accounts" | "all" | "sessions" | "stats";

interface MatchStatsUpdate {
  xpEarned: number;
  profile: PlayerProfile;
}

mkdirSync(dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
try {
  migrateDatabase(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
} catch (error) {
  db.close();
  throw error;
}

export function closeDatabase(): void {
  db.close();
}

function now(): string {
  return new Date().toISOString();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function toStats(row: UserRow): PlayerStats {
  return {
    wins: row.wins,
    losses: row.losses,
    gamesPlayed: row.games_played,
    shotsFired: row.shots_fired,
    hits: row.hits,
    shipsSunk: row.ships_sunk
  };
}

function toProfile(row: UserRow): PlayerProfile {
  const progress = xpProgress(row.xp);

  return {
    userId: row.user_id,
    username: row.username,
    avatarSeed: row.avatar_seed,
    xp: row.xp,
    level: progress.level,
    xpIntoLevel: progress.xpIntoLevel,
    xpForCurrentLevel: progress.xpForCurrentLevel,
    xpForNextLevel: progress.xpForNextLevel,
    stats: toStats(row)
  };
}

function getUserRow(userId: string): UserRow | null {
  const row = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserRow | undefined;
  return row ?? null;
}

export function sanitizeUsername(username: string): string {
  return username
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 18);
}

function assertAllowedUsername(username: string): void {
  const reservedNames = new Set(["admin", "moderator", "mod", "system", "server", "pixel fleet"]);
  if (reservedNames.has(username.toLowerCase())) {
    throw new PublicInputError("reserved_username");
  }
}

export function createGuestAccount(username: string): { profile: PlayerProfile; sessionToken: string; expiresAt: number } {
  const safeUsername = sanitizeUsername(username);
  if (safeUsername.length < 2) {
    throw new PublicInputError("short_username");
  }
  assertAllowedUsername(safeUsername);

  const userId = randomUUID();
  const avatarSeed = randomUUID();
  const createdAt = now();
  const sessionToken = createSessionToken();

  return inTransaction(db, () => {
    db.prepare(
      `INSERT INTO users (
        user_id, username, avatar_seed, xp, wins, losses, games_played,
        shots_fired, hits, ships_sunk, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)`
    ).run(userId, safeUsername, avatarSeed, createdAt, createdAt);

    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)").run(
      tokenHash(sessionToken),
      userId,
      createdAt,
      createdAt
    );

    const profile = getProfile(userId);
    if (!profile) {
      throw new Error("Could not load account.");
    }

    return { profile, sessionToken, expiresAt: sessionExpiresAt(createdAt) };
  });
}

export function getProfile(userId: string): PlayerProfile | null {
  const row = getUserRow(userId);
  return row ? toProfile(row) : null;
}

export function getSessionByToken(token: string | null): { id: string; profile: PlayerProfile; expiresAt: number } | null {
  if (!token) {
    return null;
  }

  const id = tokenHash(token);
  const row = db
    .prepare(
      `SELECT users.*, sessions.created_at AS session_created_at FROM sessions
       JOIN users ON users.user_id = sessions.user_id
       WHERE sessions.token_hash = ?`
    )
    .get(id) as (UserRow & { session_created_at: string }) | undefined;

  if (!row) {
    return null;
  }

  const expiresAt = sessionExpiresAt(row.session_created_at);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    return null;
  }

  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now(), id);
  return { id, profile: toProfile(row), expiresAt };
}

export function getProfileBySessionToken(token: string | null): PlayerProfile | null {
  return getSessionByToken(token)?.profile ?? null;
}

export function deleteSession(token: string | null): string | null {
  if (!token) {
    return null;
  }
  const id = tokenHash(token);
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(id);
  return id;
}

function updateStatsAfterMatch(userId: string, rewards: MatchRewards): MatchStatsUpdate {
  const row = getUserRow(userId);
  if (!row) {
    throw new Error("User not found while updating stats.");
  }

  const xpEarned = calculateMatchXp(rewards);
  const updatedXp = row.xp + xpEarned;

  db.prepare(
    `UPDATE users SET
      xp = ?,
      wins = wins + ?,
      losses = losses + ?,
      games_played = games_played + 1,
      shots_fired = shots_fired + ?,
      hits = hits + ?,
      ships_sunk = ships_sunk + ?,
      updated_at = ?
     WHERE user_id = ?`
  ).run(
    updatedXp,
    rewards.won ? 1 : 0,
    rewards.won ? 0 : 1,
    rewards.shotsFired,
    rewards.hits,
    rewards.shipsSunk,
    now(),
    userId
  );

  const profile = getProfile(userId);
  if (!profile) {
    throw new Error("Updated profile not found.");
  }

  return { xpEarned, profile };
}

export interface MatchCompletion {
  matchId: string;
  winnerId: string;
  reason: "ships_sunk" | "forfeit";
  players: { userId: string; shotsFired: number; hits: number; shipsSunk: number }[];
}

export class MatchCompletionConflict extends Error {}

export function completeMatch(completion: MatchCompletion): {
  applied: boolean;
  updates: { userId: string; xpEarned: number; profile: PlayerProfile | null }[];
} {
  const { matchId, winnerId, reason } = completion;
  const players = completion.players.map(({ userId, shotsFired, hits, shipsSunk }) => ({ userId, shotsFired, hits, shipsSunk }))
    .sort((a, b) => a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  if (!matchId || players.length !== 2 || players[0].userId === players[1].userId ||
    !players.some((player) => player.userId === winnerId) || !["ships_sunk", "forfeit"].includes(reason) ||
    players.some((player) => !player.userId || player.hits > player.shotsFired ||
      [player.shotsFired, player.hits, player.shipsSunk].some((n) => !Number.isSafeInteger(n) || n < 0))) {
    throw new Error("Invalid match completion.");
  }
  const decision = JSON.stringify({ winnerId, reason, players });
  return inTransaction(db, () => {
    const existing = db.prepare("SELECT decision_json, awards_json FROM match_completions WHERE match_id = ?")
      .get(matchId) as { decision_json: string; awards_json: string } | undefined;
    if (existing) {
      if (existing.decision_json !== decision) throw new MatchCompletionConflict(`Conflicting completion for match ${matchId}.`);
      const awards = JSON.parse(existing.awards_json) as number[];
      // Never restore historical totals after a stats reset, or resurrect deleted accounts.
      return { applied: false, updates: players.map((player, index) => ({
        userId: player.userId, xpEarned: awards[index], profile: getProfile(player.userId)
      })) };
    }

    const rewards = players.map((player) => ({ ...player, won: player.userId === winnerId }));
    const awards = rewards.map(calculateMatchXp);
    db.prepare("INSERT INTO match_completions (match_id, decision_json, awards_json, completed_at) VALUES (?, ?, ?, ?)")
      .run(matchId, decision, JSON.stringify(awards), now());
    const updates = rewards.map((reward) => ({ userId: reward.userId, ...updateStatsAfterMatch(reward.userId, reward) }));
    return { applied: true, updates };
  });
}

export function profileHitRate(profile: PlayerProfile): number {
  return hitRate(profile.stats);
}

export function getDatabaseStats(): DatabaseStats {
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        COALESCE(SUM(xp), 0) AS totalXp,
        COALESCE(SUM(games_played), 0) AS totalGamesPlayed,
        COALESCE(SUM(shots_fired), 0) AS totalShotsFired,
        COALESCE(SUM(hits), 0) AS totalHits
       FROM users`
    )
    .get() as {
    users: number;
    sessions: number;
    totalXp: number;
    totalGamesPlayed: number;
    totalShotsFired: number;
    totalHits: number;
  };

  return row;
}

export function resetDatabase(scope: ResetScope): DatabaseStats {
  // Completion receipts deliberately survive every reset, including account deletion.
  switch (scope) {
    case "sessions":
      db.prepare("DELETE FROM sessions").run();
      break;
    case "stats":
      db.prepare(
        `UPDATE users SET
          xp = 0,
          wins = 0,
          losses = 0,
          games_played = 0,
          shots_fired = 0,
          hits = 0,
          ships_sunk = 0,
          updated_at = ?`
      ).run(now());
      break;
    case "accounts":
    case "all":
      db.prepare("DELETE FROM users").run();
      break;
  }

  return getDatabaseStats();
}
