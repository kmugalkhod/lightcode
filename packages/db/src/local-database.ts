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

export function resolveDatabaseUrl() {
  const configuredUrl = process.env.DATABASE_URL?.trim();
  const supportedConfiguredUrl =
    configuredUrl?.startsWith("file:") ||
    configuredUrl?.startsWith("libsql:") ||
    configuredUrl?.startsWith("http://") ||
    configuredUrl?.startsWith("https://")
      ? configuredUrl
      : null;
  const databaseUrl = supportedConfiguredUrl && supportedConfiguredUrl.length > 0
    ? supportedConfiguredUrl
    : getDefaultDatabaseUrl();

  process.env.DATABASE_URL = databaseUrl;
  return databaseUrl;
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
