import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listCheckpointTurns,
  recordFileCheckpoint,
  undoLastTurn,
} from "./runtime";

let tempHome: string;
let workspace: string;
const originalLightcodeHome = process.env.LIGHTCODE_HOME;
const sessionId = "checkpoint-test-session";

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(tmpdir(), "lightcode-checkpoints-"));
  workspace = path.join(tempHome, "workspace");
  await mkdir(workspace, { recursive: true });
  process.env.LIGHTCODE_HOME = tempHome;
});

afterEach(async () => {
  if (originalLightcodeHome === undefined) {
    delete process.env.LIGHTCODE_HOME;
  } else {
    process.env.LIGHTCODE_HOME = originalLightcodeHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("checkpoints", () => {
  test("undo restores a modified file and deletes a created file", async () => {
    const modifiedPath = path.join(workspace, "modified.txt");
    const createdPath = path.join(workspace, "created.txt");
    await writeFile(modifiedPath, "original", "utf8");

    await recordFileCheckpoint({
      sessionId,
      turnKey: "turn-1",
      absolutePath: modifiedPath,
      workspaceRelativePath: "modified.txt",
      previousContent: "original",
    });
    await recordFileCheckpoint({
      sessionId,
      turnKey: "turn-1",
      absolutePath: createdPath,
      workspaceRelativePath: "created.txt",
      previousContent: null,
    });

    // Simulate the agent's edits.
    await writeFile(modifiedPath, "changed", "utf8");
    await writeFile(createdPath, "new file", "utf8");

    const result = await undoLastTurn({ sessionId });

    expect(result?.turnKey).toBe("turn-1");
    expect(result?.restoredFiles.sort()).toEqual(["created.txt", "modified.txt"]);
    expect(await readFile(modifiedPath, "utf8")).toBe("original");
    expect(existsSync(createdPath)).toBe(false);
  });

  test("repeated undo walks back one turn at a time", async () => {
    const filePath = path.join(workspace, "file.txt");
    await writeFile(filePath, "v1", "utf8");

    await recordFileCheckpoint({
      sessionId,
      turnKey: "turn-1",
      absolutePath: filePath,
      workspaceRelativePath: "file.txt",
      previousContent: "v1",
    });
    await writeFile(filePath, "v2", "utf8");

    await recordFileCheckpoint({
      sessionId,
      turnKey: "turn-2",
      absolutePath: filePath,
      workspaceRelativePath: "file.txt",
      previousContent: "v2",
    });
    await writeFile(filePath, "v3", "utf8");

    expect((await listCheckpointTurns({ sessionId })).length).toBe(2);

    const firstUndo = await undoLastTurn({ sessionId });
    expect(firstUndo?.turnKey).toBe("turn-2");
    expect(await readFile(filePath, "utf8")).toBe("v2");

    const secondUndo = await undoLastTurn({ sessionId });
    expect(secondUndo?.turnKey).toBe("turn-1");
    expect(await readFile(filePath, "utf8")).toBe("v1");

    expect(await undoLastTurn({ sessionId })).toBeNull();
  });

  test("only the first write in a turn captures the original state", async () => {
    const filePath = path.join(workspace, "repeat.txt");
    await writeFile(filePath, "original", "utf8");

    await recordFileCheckpoint({
      sessionId,
      turnKey: "turn-1",
      absolutePath: filePath,
      workspaceRelativePath: "repeat.txt",
      previousContent: "original",
    });
    // Second write in the same turn must not overwrite the snapshot.
    await recordFileCheckpoint({
      sessionId,
      turnKey: "turn-1",
      absolutePath: filePath,
      workspaceRelativePath: "repeat.txt",
      previousContent: "intermediate",
    });
    await writeFile(filePath, "final", "utf8");

    await undoLastTurn({ sessionId });
    expect(await readFile(filePath, "utf8")).toBe("original");
  });

  test("undo with no checkpoints returns null", async () => {
    expect(await undoLastTurn({ sessionId: "empty-session" })).toBeNull();
  });
});
