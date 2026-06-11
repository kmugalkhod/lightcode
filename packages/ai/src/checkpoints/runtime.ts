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
});

const checkpointTurnSchema = z.object({
  turnKey: z.string().min(1),
  createdAt: z.string().min(1),
  files: z.array(checkpointFileEntrySchema),
});

const checkpointManifestSchema = z.object({
  turns: z.array(checkpointTurnSchema),
});

export type CheckpointTurn = z.infer<typeof checkpointTurnSchema>;

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
    return parsed.success ? parsed.data : { turns: [] };
  } catch {
    return { turns: [] };
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
  let turn = manifest.turns.find((entry) => entry.turnKey === turnKey);
  if (!turn) {
    turn = { turnKey, createdAt: new Date().toISOString(), files: [] };
    manifest.turns.push(turn);
  }

  const alreadyRecorded = turn.files.some(
    (file) => file.workspaceRelativePath === workspaceRelativePath,
  );
  if (alreadyRecorded) {
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

  turn.files.push({ workspaceRelativePath, absolutePath, snapshotFile });
  await saveManifest(sessionId, manifest);
}

/**
 * Reverts every file edited in the most recent checkpointed turn. Files that
 * did not exist before the turn are deleted. Returns null when there is
 * nothing to undo. Repeated calls walk further back turn by turn.
 */
export async function undoLastTurn({
  sessionId,
}: {
  sessionId: string;
}): Promise<{ restoredFiles: string[]; turnKey: string } | null> {
  const manifest = await loadManifest(sessionId);
  const turn = manifest.turns.pop();
  if (!turn) {
    return null;
  }

  const restoredFiles: string[] = [];
  for (let index = turn.files.length - 1; index >= 0; index -= 1) {
    const file = turn.files[index];

    if (file.snapshotFile === null) {
      await fs.rm(file.absolutePath, { force: true });
    } else {
      const snapshotPath = path.join(
        getCheckpointsDir(sessionId),
        file.snapshotFile,
      );
      const snapshotContent = await fs.readFile(snapshotPath, "utf8");
      await fs.mkdir(path.dirname(file.absolutePath), { recursive: true });
      await fs.writeFile(file.absolutePath, snapshotContent, "utf8");
      await fs.rm(snapshotPath, { force: true });
    }

    restoredFiles.push(file.workspaceRelativePath);
  }

  await saveManifest(sessionId, manifest);
  return { restoredFiles, turnKey: turn.turnKey };
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
