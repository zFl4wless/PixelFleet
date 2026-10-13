import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

export function inTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // Some SQLite errors roll the transaction back themselves.
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function migrateDatabase(db: DatabaseSync): void {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported database schema version ${version}; expected at most ${SCHEMA_VERSION}.`);
  if (version === SCHEMA_VERSION) return;

  // Version 0 covers both a new database and the original unversioned schema.
  inTransaction(db, () => {
    db.exec(`
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
      CREATE TABLE match_completions (
        match_id TEXT PRIMARY KEY NOT NULL,
        decision_json TEXT NOT NULL,
        awards_json TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );
    `);
    // Reject incompatible version-0 tables before committing the migration.
    db.prepare(`SELECT user_id, username, avatar_seed, xp, wins, losses, games_played,
      shots_fired, hits, ships_sunk, created_at, updated_at FROM users LIMIT 0`).all();
    db.prepare("SELECT token_hash, user_id, created_at, last_seen_at FROM sessions LIMIT 0").all();
    db.exec("PRAGMA user_version = 1");
  });
}
