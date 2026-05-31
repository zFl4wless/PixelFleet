import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
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

export interface MatchStatsUpdate {
  xpEarned: number;
  profile: PlayerProfile;
}

mkdirSync(dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    avatar_seed TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    games_played INTEGER NOT NULL DEFAULT 0,
    shots_fired INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    ships_sunk INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
`);

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
    throw new Error("This username is reserved.");
  }
}

export function createGuestAccount(username: string): { profile: PlayerProfile; sessionToken: string } {
  const safeUsername = sanitizeUsername(username);
  if (safeUsername.length < 2) {
    throw new Error("Username must be at least 2 characters.");
  }
  assertAllowedUsername(safeUsername);

  const userId = randomUUID();
  const avatarSeed = randomUUID();
  const createdAt = now();
  const sessionToken = createSessionToken();

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

  return { profile, sessionToken };
}

export function getProfile(userId: string): PlayerProfile | null {
  const row = getUserRow(userId);
  return row ? toProfile(row) : null;
}

export function getProfileBySessionToken(token: string | null): PlayerProfile | null {
  if (!token) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.user_id = sessions.user_id
       WHERE sessions.token_hash = ?`
    )
    .get(tokenHash(token)) as UserRow | undefined;

  if (!row) {
    return null;
  }

  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now(), tokenHash(token));
  return toProfile(row);
}

export function deleteSession(token: string | null): void {
  if (!token) {
    return;
  }
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function updateStatsAfterMatch(userId: string, rewards: MatchRewards): MatchStatsUpdate {
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
