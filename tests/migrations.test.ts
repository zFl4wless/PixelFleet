import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../apps/backend/src/migrations";

// The original, unversioned schema: migration tests must not use the new initializer.
const legacySchema = `
  CREATE TABLE users (
    user_id TEXT PRIMARY KEY, username TEXT NOT NULL, avatar_seed TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0, games_played INTEGER NOT NULL DEFAULT 0,
    shots_fired INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
    ships_sunk INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
  );`;
let directory: string;
let db: DatabaseSync;
let backend: typeof import("../apps/backend/src/db") | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  directory = await mkdtemp(join(tmpdir(), "pixelfleet-migration-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "legacy.sqlite"));
  db = new DatabaseSync(process.env.DATABASE_PATH!);
});

afterEach(async () => {
  backend?.closeDatabase(); backend = undefined;
  db.close();
  vi.useRealTimers(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function version() { return db.prepare("PRAGMA user_version").get()!.user_version; }
function schema() { return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(); }
function seedLegacy() {
  db.exec(legacySchema);
  db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-user", "Legacy guest", "old-avatar", 999, 2, 1, 3, 45, 29, 8, new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)")
    .run(createHash("sha256").update("legacy-token").digest("hex"), "legacy-user", new Date().toISOString(), new Date().toISOString());
}

describe("versioned transactional migration (TD-05)", () => {
  it("initializes a new database at version 1 and is unchanged by a second migration", () => {
    migrateDatabase(db);
    expect(version()).toBe(1);
    expect(schema().filter((r) => r.type === "table").map((r) => r.name)).toEqual(["match_completions", "sessions", "users"]);
    const before = schema();
    migrateDatabase(db);
    expect(schema()).toEqual(before);
  });

  it("migrates real legacy accounts, sessions, XP and all statistics unchanged, including restart", async () => {
    seedLegacy();
    const users = db.prepare("SELECT * FROM users").all();
    const sessions = db.prepare("SELECT * FROM sessions").all();
    backend = await import("../apps/backend/src/db");
    expect(version()).toBe(1);
    expect(db.prepare("SELECT * FROM users").all()).toEqual(users);
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual(sessions);
    expect(backend.getSessionByToken("legacy-token")?.profile).toMatchObject({
      userId: "legacy-user", xp: 999, stats: { wins: 2, losses: 1, gamesPlayed: 3, shotsFired: 45, hits: 29, shipsSunk: 8 }
    });
    backend.closeDatabase(); backend = undefined;
    vi.resetModules();
    backend = await import("../apps/backend/src/db");
    expect(version()).toBe(1);
    expect(db.prepare("SELECT * FROM users").all()).toEqual(users);
    expect(backend.getSessionByToken("legacy-token")?.profile.userId).toBe("legacy-user");
    expect(db.prepare("SELECT COUNT(*) AS count FROM match_completions").get()!.count).toBe(0);
  });

  it.each([false, true])("rolls back every schema change and version on failure (legacy=%s), then allows repair", async (legacy) => {
    if (legacy) seedLegacy();
    db.exec("CREATE VIEW match_completions AS SELECT 1 AS fixture");
    const before = schema();
    const users = legacy ? db.prepare("SELECT * FROM users").all() : [];
    await expect(import("../apps/backend/src/db")).rejects.toThrow(/already exists/);
    expect(version()).toBe(0);
    expect(schema()).toEqual(before);
    if (legacy) expect(db.prepare("SELECT * FROM users").all()).toEqual(users);
    db.exec("DROP VIEW match_completions");
    vi.resetModules();
    backend = await import("../apps/backend/src/db");
    expect(version()).toBe(1);
  });

  it("rejects incompatible legacy columns without advancing the version or adding tables", () => {
    db.exec("CREATE TABLE users (user_id TEXT PRIMARY KEY)");
    const before = schema();
    expect(() => migrateDatabase(db)).toThrow(/no such column/);
    expect(schema()).toEqual(before);
    expect(version()).toBe(0);
  });

  it("refuses a newer schema at startup without changing its data, schema, or journal mode", async () => {
    seedLegacy();
    db.exec("PRAGMA user_version = 2");
    const before = schema();
    const users = db.prepare("SELECT * FROM users").all();
    const journal = db.prepare("PRAGMA journal_mode").get();
    await expect(import("../apps/backend/src/db")).rejects.toThrow(/Unsupported database schema version 2/);
    expect(version()).toBe(2);
    expect(schema()).toEqual(before);
    expect(db.prepare("SELECT * FROM users").all()).toEqual(users);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual(journal);
  });
});
