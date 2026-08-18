import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir, platform } from "node:os";

const appDirectoryName = "lightcode";
const databaseFileName = "lightcode.db";

function getDefaultLightcodeDataDir() {
  const configuredHome = process.env.LIGHTCODE_HOME?.trim();
  if (configuredHome) {
    return resolve(configuredHome);
  }

  if (platform() === "win32") {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA;
    return appData
      ? join(appData, appDirectoryName)
      : join(homedir(), "AppData", "Roaming", appDirectoryName);
  }

  return join(homedir(), `.${appDirectoryName}`);
}

export function getDefaultDatabasePath() {
  const configuredPath = process.env.LIGHTCODE_DATABASE_PATH?.trim();
  return configuredPath
    ? resolve(configuredPath)
    : join(getDefaultLightcodeDataDir(), databaseFileName);
}

export function getDefaultDatabaseUrl() {
  return pathToFileURL(getDefaultDatabasePath()).href;
}

/**
 * Resolves the Lightcode session-store URL.
 *
 * Lightcode is a coding agent that runs *inside* the user's projects, and the
 * runtime (Bun) auto-loads a `.env` from the launch directory. That means the
 * ambient `DATABASE_URL` belongs to the user's project — not to Lightcode — so
 * we must never use it: doing so scattered Lightcode's sessions into whatever
 * database the current project pointed at (e.g. a project with
 * `DATABASE_URL="file:./prisma/dev.db"` had Lightcode write its sessions into
 * that project's own SQLite file), making previously saved sessions vanish from
 * `/sessions` whenever the launch directory changed.
 *
 * The store is therefore a fixed per-user location, overridable only via
 * Lightcode-namespaced inputs that cannot collide with a project's env:
 *   1. `LIGHTCODE_DATABASE_URL` — opt-in for a libsql/Turso or alternate file URL
 *   2. `LIGHTCODE_DATABASE_PATH` — opt-in file path (via {@link getDefaultDatabaseUrl})
 *   3. the default `~/.lightcode/lightcode.db` (or `%APPDATA%\lightcode` on Windows)
 */
export function resolveDatabaseUrl() {
  const configuredUrl = process.env.LIGHTCODE_DATABASE_URL?.trim();
  const supportedConfiguredUrl =
    configuredUrl &&
    (configuredUrl.startsWith("file:") ||
      configuredUrl.startsWith("libsql:") ||
      configuredUrl.startsWith("http://") ||
      configuredUrl.startsWith("https://"))
      ? configuredUrl
      : null;

  return supportedConfiguredUrl ?? getDefaultDatabaseUrl();
}

export function filePathFromDatabaseUrl(databaseUrl: string) {
  if (!databaseUrl.startsWith("file:")) {
    return null;
  }

  if (databaseUrl.startsWith("file://")) {
    return fileURLToPath(databaseUrl);
  }

  const rawPath = databaseUrl.slice("file:".length);
  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

function ensureParentDirectory(filePath: string) {
  const parentDirectory = dirname(filePath);
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }
}

export function initializeLocalDatabase(databaseUrl: string) {
  const databasePath = filePathFromDatabaseUrl(databaseUrl);
  if (!databasePath) {
    return;
  }

  ensureParentDirectory(databasePath);

  const database = new Database(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS "sessions" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT,
        "cwd" TEXT,
        "mode" TEXT NOT NULL DEFAULT 'build',
        "permission_mode" TEXT,
        "model" TEXT,
        "revision" INTEGER NOT NULL DEFAULT 0,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS "sessions_updated_at_idx"
        ON "sessions"("updated_at");

      CREATE TABLE IF NOT EXISTS "messages" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "message_id" TEXT NOT NULL,
        "role" TEXT NOT NULL,
        "model" TEXT,
        "sequence" INTEGER NOT NULL,
        "payload" JSONB NOT NULL,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "messages_session_id_fkey"
          FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "messages_session_id_message_id_key"
        ON "messages"("session_id", "message_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "messages_session_id_sequence_key"
        ON "messages"("session_id", "sequence");
      CREATE INDEX IF NOT EXISTS "messages_session_id_sequence_idx"
        ON "messages"("session_id", "sequence");
      CREATE INDEX IF NOT EXISTS "messages_session_id_role_idx"
        ON "messages"("session_id", "role");

      CREATE TABLE IF NOT EXISTS "message_parts" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "message_id" TEXT NOT NULL,
        "part_index" INTEGER NOT NULL,
        "payload" JSONB NOT NULL,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "message_parts_message_id_fkey"
          FOREIGN KEY ("message_id") REFERENCES "messages"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "message_parts_message_id_part_index_key"
        ON "message_parts"("message_id", "part_index");
      CREATE INDEX IF NOT EXISTS "message_parts_message_id_part_index_idx"
        ON "message_parts"("message_id", "part_index");

      -- One-release compatibility backfill: legacy rows keep their JSON
      -- payload, while normalized part records become authoritative for new
      -- run/event workflows. INSERT OR IGNORE makes startup idempotent.
      INSERT OR IGNORE INTO "message_parts"
        ("id", "message_id", "part_index", "payload", "created_at")
      SELECT
        lower(hex(randomblob(16))),
        message."id",
        CAST(part."key" AS INTEGER),
        json(part."value"),
        message."created_at"
      FROM "messages" AS message, json_each(message."payload", '$.parts') AS part
      WHERE json_valid(message."payload")
        AND json_type(message."payload", '$.parts') = 'array';

      CREATE TABLE IF NOT EXISTS "chat_runs" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "client_turn_id" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "base_revision" INTEGER NOT NULL,
        "final_revision" INTEGER,
        "error" TEXT,
        "started_at" DATETIME,
        "finished_at" DATETIME,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "chat_runs_session_id_fkey"
          FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "chat_runs_session_id_client_turn_id_key"
        ON "chat_runs"("session_id", "client_turn_id");
      CREATE INDEX IF NOT EXISTS "chat_runs_session_id_status_idx"
        ON "chat_runs"("session_id", "status");

      CREATE TABLE IF NOT EXISTS "chat_run_events" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "cursor" INTEGER NOT NULL,
        "kind" TEXT NOT NULL,
        "payload" JSONB NOT NULL,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "chat_run_events_run_id_fkey"
          FOREIGN KEY ("run_id") REFERENCES "chat_runs"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "chat_run_events_run_id_cursor_key"
        ON "chat_run_events"("run_id", "cursor");
      CREATE INDEX IF NOT EXISTS "chat_run_events_run_id_cursor_idx"
        ON "chat_run_events"("run_id", "cursor");

      CREATE TABLE IF NOT EXISTS "chat_turn_reverts" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "turn_key" TEXT NOT NULL,
        "messages" JSONB NOT NULL,
        "state" TEXT NOT NULL DEFAULT 'undone',
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "reapplied_at" DATETIME,
        CONSTRAINT "chat_turn_reverts_session_id_fkey"
          FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS "chat_turn_reverts_session_state_created_at_idx"
        ON "chat_turn_reverts"("session_id", "state", "created_at");

      CREATE TABLE IF NOT EXISTS "chat_interactions" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "tool_call_id" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "payload" JSONB NOT NULL,
        "response" JSONB,
        "resolved_at" DATETIME,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "chat_interactions_session_id_fkey"
          FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "chat_interactions_session_id_tool_call_id_key"
        ON "chat_interactions"("session_id", "tool_call_id");
      CREATE INDEX IF NOT EXISTS "chat_interactions_session_id_status_idx"
        ON "chat_interactions"("session_id", "status");
      CREATE INDEX IF NOT EXISTS "chat_interactions_status_updated_at_idx"
        ON "chat_interactions"("status", "updated_at");

      CREATE TABLE IF NOT EXISTS "subagent_tasks" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "parent_session_id" TEXT NOT NULL,
        "prompt" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "mode" TEXT NOT NULL DEFAULT 'plan',
        "model" TEXT,
        "allowed_tools" JSONB NOT NULL DEFAULT '[]',
        "output" JSONB,
        "error" TEXT,
        "started_at" DATETIME,
        "finished_at" DATETIME,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "subagent_tasks_parent_session_id_fkey"
          FOREIGN KEY ("parent_session_id") REFERENCES "sessions"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS "subagent_tasks_parent_session_created_at_idx"
        ON "subagent_tasks"("parent_session_id", "created_at");
      CREATE INDEX IF NOT EXISTS "subagent_tasks_status_updated_at_idx"
        ON "subagent_tasks"("status", "updated_at");

      CREATE TABLE IF NOT EXISTS "session_context_states" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "summary" TEXT NOT NULL,
        "anchor_message_id" TEXT NOT NULL,
        "covered_message_count" INTEGER NOT NULL,
        "estimated_tokens" INTEGER NOT NULL,
        "tier" TEXT NOT NULL,
        "model" TEXT,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "session_context_states_session_id_fkey"
          FOREIGN KEY ("session_id") REFERENCES "sessions"("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "session_context_states_session_id_key"
        ON "session_context_states"("session_id");
    `);

    applyAdditiveMigrations(database);
  } finally {
    database.close();
  }
}

/**
 * CREATE TABLE IF NOT EXISTS does not evolve existing tables; add new
 * columns here, guarded so re-runs are no-ops.
 */
function applyAdditiveMigrations(database: Database) {
  const sessionColumns = database
    .query<{ name: string }, []>("PRAGMA table_info(sessions)")
    .all();

  if (!sessionColumns.some((column) => column.name === "auto_titled")) {
    database.exec(
      'ALTER TABLE "sessions" ADD COLUMN "auto_titled" BOOLEAN NOT NULL DEFAULT 0',
    );
  }
}
