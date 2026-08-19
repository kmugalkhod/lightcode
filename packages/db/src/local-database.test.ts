import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { initializeLocalDatabase } from "./local-database";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("local database migrations", () => {
  test("adds nullable workspace identity columns to an existing sessions table", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lightcode-db-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "legacy.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE "sessions" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT,
        "auto_titled" BOOLEAN NOT NULL DEFAULT 0,
        "cwd" TEXT,
        "mode" TEXT NOT NULL DEFAULT 'build',
        "permission_mode" TEXT,
        "model" TEXT,
        "revision" INTEGER NOT NULL DEFAULT 0,
        "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacy.close();

    initializeLocalDatabase(pathToFileURL(databasePath).href);

    const migrated = new Database(databasePath, { readonly: true });
    try {
      const columns = migrated
        .query<{ name: string }, []>("PRAGMA table_info(sessions)")
        .all()
        .map((column) => column.name);
      expect(columns).toContain("workspace_device");
      expect(columns).toContain("workspace_inode");
    } finally {
      migrated.close();
    }
  });
});
