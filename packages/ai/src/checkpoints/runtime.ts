import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getLightcodeDataDir } from "@lightcode/shared";
import { z } from "zod";

const checkpointFileEntrySchema = z.object({
  workspaceRelativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  /** Snapshot filename, or null when the file did not exist before the turn. */
  snapshotFile: z.string().nullable(),
  beforeHash: z.string().nullable().optional(),
  expectedAfterHash: z.string().nullable().optional(),
  expectedAfterExists: z.boolean().optional(),
  redoSnapshotFile: z.string().nullable().optional(),
  redoExists: z.boolean().optional(),
});

const checkpointTurnSchema = z.object({
  turnKey: z.string().min(1),
  createdAt: z.string().min(1),
  files: z.array(checkpointFileEntrySchema),
});

const checkpointManifestSchema = z.object({
  turns: z.array(checkpointTurnSchema),
  redoTurns: z.array(checkpointTurnSchema).default([]),
});

export type CheckpointTurn = z.infer<typeof checkpointTurnSchema>;

export class CheckpointConflictError extends Error {
  constructor(readonly files: string[]) {
    super(
      `Checkpoint cannot be applied because these files changed after the turn: ${files.join(
        ", ",
      )}`,
    );
    this.name = "CheckpointConflictError";
  }
}

export interface CheckpointTurnSummary {
  turnKey: string;
  createdAt: string;
  fileCount: number;
  files: string[];
}

function safeSessionDirName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function getCheckpointsDir(sessionId: string): string {
  return path.join(
    getLightcodeDataDir(),
    "checkpoints",
    safeSessionDirName(sessionId),
  );
}

function getManifestPath(sessionId: string): string {
  return path.join(getCheckpointsDir(sessionId), "manifest.json");
}

async function loadManifest(sessionId: string) {
  try {
    const raw = JSON.parse(
      await fs.readFile(getManifestPath(sessionId), "utf8"),
    );
    const parsed = checkpointManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : { turns: [], redoTurns: [] };
  } catch {
    return { turns: [], redoTurns: [] };
  }
}

function contentHash(content: string | null): string | null {
  return content === null
    ? null
    : createHash("sha256").update(content).digest("hex");
}

async function readCurrentContent(absolutePath: string): Promise<string | null> {
  try {
    return await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : null;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function clearRedoSnapshots(
  sessionId: string,
  turns: readonly CheckpointTurn[],
) {
  for (const turn of turns) {
    for (const file of turn.files) {
      for (const snapshotFile of [file.snapshotFile, file.redoSnapshotFile]) {
        if (snapshotFile) {
          await fs.rm(path.join(getCheckpointsDir(sessionId), snapshotFile), {
            force: true,
          });
        }
      }
    }
  }
}

async function saveManifest(
  sessionId: string,
  manifest: z.infer<typeof checkpointManifestSchema>,
) {
  const manifestPath = getManifestPath(sessionId);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Snapshots a file's pre-edit state once per turn (the first write in a turn
 * captures the original content; later writes to the same file are no-ops).
 */
export async function recordFileCheckpoint({
  sessionId,
  turnKey,
  absolutePath,
  workspaceRelativePath,
  previousContent,
}: {
  sessionId: string;
  turnKey: string;
  absolutePath: string;
  workspaceRelativePath: string;
  /** null when the file did not exist before this turn. */
  previousContent: string | null;
}): Promise<void> {
  const manifest = await loadManifest(sessionId);
  let clearedRedo = false;
  if (manifest.redoTurns.length > 0) {
    await clearRedoSnapshots(sessionId, manifest.redoTurns);
    manifest.redoTurns = [];
    clearedRedo = true;
  }
  let turn = manifest.turns.find((entry) => entry.turnKey === turnKey);
  if (!turn) {
    turn = { turnKey, createdAt: new Date().toISOString(), files: [] };
    manifest.turns.push(turn);
  }

  const alreadyRecorded = turn.files.some(
    (file) => file.workspaceRelativePath === workspaceRelativePath,
  );
  if (alreadyRecorded) {
    if (clearedRedo) {
      await saveManifest(sessionId, manifest);
    }
    return;
  }

  let snapshotFile: string | null = null;
  if (previousContent !== null) {
    const pathHash = createHash("sha1")
      .update(workspaceRelativePath)
      .digest("hex")
      .slice(0, 12);
    snapshotFile = `${turnKey}-${pathHash}.snap`;
    const snapshotPath = path.join(getCheckpointsDir(sessionId), snapshotFile);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, previousContent, "utf8");
  }

  turn.files.push({
    workspaceRelativePath,
    absolutePath,
    snapshotFile,
    beforeHash: contentHash(previousContent),
    expectedAfterHash: undefined,
    expectedAfterExists: undefined,
    redoSnapshotFile: undefined,
    redoExists: undefined,
  });
  await saveManifest(sessionId, manifest);
}

/** Records the expected post-edit state used to detect workspace drift. */
export async function recordFileCheckpointResult({
  sessionId,
  turnKey,
  absolutePath,
  currentContent,
}: {
  sessionId: string;
  turnKey: string;
  absolutePath: string;
  currentContent: string;
}): Promise<void> {
  const manifest = await loadManifest(sessionId);
  const turn = manifest.turns.find((entry) => entry.turnKey === turnKey);
  const file = turn?.files.find((entry) => entry.absolutePath === absolutePath);
  if (!file) {
    return;
  }

  file.expectedAfterExists = true;
  file.expectedAfterHash = contentHash(currentContent);
  await saveManifest(sessionId, manifest);
}

async function assertCheckpointState(
  sessionId: string,
  turn: CheckpointTurn,
  expected: "before" | "after",
) {
  const conflicts: string[] = [];
  for (const file of turn.files) {
    const current = await readCurrentContent(file.absolutePath);
    const currentHash = contentHash(current);
    let expectedHash: string | null | undefined;
    let hasExpectation = true;
    if (expected === "before") {
      if (file.beforeHash !== undefined) {
        expectedHash = file.beforeHash;
      } else if (file.snapshotFile) {
        expectedHash = contentHash(
          await fs
            .readFile(
              path.join(getCheckpointsDir(sessionId), file.snapshotFile),
              "utf8",
            )
            .catch(() => null),
        );
      } else {
        expectedHash = null;
      }
    } else {
      hasExpectation = file.expectedAfterExists !== undefined;
      expectedHash = file.expectedAfterHash;
    }
    if (hasExpectation && currentHash !== expectedHash) {
      conflicts.push(file.workspaceRelativePath);
    }
  }
  if (conflicts.length > 0) {
    throw new CheckpointConflictError(conflicts);
  }
}

async function captureRedoState(sessionId: string, turn: CheckpointTurn) {
  const checkpointDir = getCheckpointsDir(sessionId);
  await fs.mkdir(checkpointDir, { recursive: true });

  for (const file of turn.files) {
    const current = await readCurrentContent(file.absolutePath);
    file.redoExists = current !== null;
    file.redoSnapshotFile = null;
    if (current !== null) {
      const pathHash = createHash("sha1")
        .update(file.workspaceRelativePath)
        .digest("hex")
        .slice(0, 12);
      file.redoSnapshotFile = `redo-${turn.turnKey}-${pathHash}.snap`;
      await fs.writeFile(
        path.join(checkpointDir, file.redoSnapshotFile),
        current,
        "utf8",
      );
    }
  }
}

async function applyTurnState({
  sessionId,
  turn,
  target,
}: {
  sessionId: string;
  turn: CheckpointTurn;
  target: "before" | "after";
}) {
  const orderedFiles = [...turn.files].reverse();
  for (const file of orderedFiles) {
    await writeSnapshotState({
      sessionId,
      file,
      snapshotFile:
        target === "before" ? file.snapshotFile : file.redoSnapshotFile,
      exists:
        target === "before" ? file.snapshotFile !== null : file.redoExists === true,
    });
  }
}

async function writeSnapshotState({
  sessionId,
  file,
  snapshotFile,
  exists,
}: {
  sessionId: string;
  file: z.infer<typeof checkpointFileEntrySchema>;
  snapshotFile: string | null | undefined;
  exists: boolean;
}) {
  if (!exists) {
    await fs.rm(file.absolutePath, { force: true });
    return;
  }
  if (!snapshotFile) {
    throw new Error(`Checkpoint snapshot is missing for ${file.workspaceRelativePath}.`);
  }
  const snapshotContent = await fs.readFile(
    path.join(getCheckpointsDir(sessionId), snapshotFile),
    "utf8",
  );
  await fs.mkdir(path.dirname(file.absolutePath), { recursive: true });
  await fs.writeFile(file.absolutePath, snapshotContent, "utf8");
}

/**
 * Reverts every file edited in the most recent checkpointed turn. Files that
 * did not exist before the turn are deleted. Returns null when there is
 * nothing to undo. Repeated calls walk further back turn by turn.
 */
export async function undoCheckpointTurn({
  sessionId,
  turnKey,
}: {
  sessionId: string;
  turnKey?: string;
}): Promise<{ restoredFiles: string[]; turnKey: string } | null> {
  const manifest = await loadManifest(sessionId);
  const turn = manifest.turns.at(-1);
  if (!turn) {
    return null;
  }
  if (turnKey !== undefined && turn.turnKey !== turnKey) {
    return null;
  }

  await assertCheckpointState(sessionId, turn, "after");
  await captureRedoState(sessionId, turn);
  await applyTurnState({ sessionId, turn, target: "before" });

  manifest.turns.pop();
  manifest.redoTurns.push(turn);
  await saveManifest(sessionId, manifest);
  return {
    restoredFiles: turn.files.map((file) => file.workspaceRelativePath),
    turnKey: turn.turnKey,
  };
}

export async function undoLastTurn({
  sessionId,
}: {
  sessionId: string;
}): Promise<{ restoredFiles: string[]; turnKey: string } | null> {
  return undoCheckpointTurn({ sessionId });
}

/** Reapplies the most recently undone checkpointed turn. */
export async function redoLastTurn({
  sessionId,
  turnKey,
}: {
  sessionId: string;
  turnKey?: string;
}): Promise<{ restoredFiles: string[]; turnKey: string } | null> {
  const manifest = await loadManifest(sessionId);
  const turn = manifest.redoTurns.at(-1);
  if (!turn) {
    return null;
  }
  if (turnKey !== undefined && turn.turnKey !== turnKey) {
    return null;
  }

  await assertCheckpointState(sessionId, turn, "before");
  await applyTurnState({ sessionId, turn, target: "after" });

  manifest.redoTurns.pop();
  manifest.turns.push(turn);
  await saveManifest(sessionId, manifest);
  return {
    restoredFiles: turn.files.map((file) => file.workspaceRelativePath),
    turnKey: turn.turnKey,
  };
}

/** Permanently discards the redo branch after a new edit/turn is admitted. */
export async function clearCheckpointRedo({
  sessionId,
}: {
  sessionId: string;
}): Promise<void> {
  const manifest = await loadManifest(sessionId);
  if (manifest.redoTurns.length === 0) {
    return;
  }

  await clearRedoSnapshots(sessionId, manifest.redoTurns);
  manifest.redoTurns = [];
  await saveManifest(sessionId, manifest);
}

export async function listCheckpointTurns({
  sessionId,
}: {
  sessionId: string;
}): Promise<CheckpointTurnSummary[]> {
  const manifest = await loadManifest(sessionId);
  return manifest.turns.map((turn) => ({
    turnKey: turn.turnKey,
    createdAt: turn.createdAt,
    fileCount: turn.files.length,
    files: turn.files.map((file) => file.workspaceRelativePath),
  }));
}
