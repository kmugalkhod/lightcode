import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  recordFileCheckpoint,
  recordFileCheckpointResult,
} from "@lightcode/ai/runtime";
import type { UIMessage } from "ai";

let tempHome: string;
let workspace: string;
const originalLightcodeHome = process.env.LIGHTCODE_HOME;

function message(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(tmpdir(), "lightcode-history-"));
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

describe("session history", () => {
  test(
    "undo and redo restore the transcript and files as one turn",
    async () => {
      const {
        createChatSession,
        deleteChatSession,
        loadChatSessionWithMessages,
        persistChatMessages,
      } = await import("./chat-store");
      const { redoSessionTurn, undoSessionTurn } = await import(
        "./chat-history-store"
      );
      const session = await createChatSession({ cwd: workspace });
      const filePath = path.join(workspace, "tracked.txt");
      const allMessages = [
        message("u1", "user", "first"),
        message("a1", "assistant", "first answer"),
        message("u2", "user", "change the file"),
        message("a2", "assistant", "done"),
      ];

      try {
        await persistChatMessages({
          sessionId: session.id,
          messages: allMessages,
          expectedRevision: 0,
        });
        await writeFile(filePath, "before", "utf8");
        await recordFileCheckpoint({
          sessionId: session.id,
          turnKey: "u2",
          absolutePath: filePath,
          workspaceRelativePath: "tracked.txt",
          previousContent: "before",
        });
        await writeFile(filePath, "after", "utf8");
        await recordFileCheckpointResult({
          sessionId: session.id,
          turnKey: "u2",
          absolutePath: filePath,
          currentContent: "after",
        });

        const undone = await undoSessionTurn(session.id);
        expect(undone).toMatchObject({
          turnKey: "u2",
          restoredFiles: ["tracked.txt"],
          messageCount: 2,
        });
        expect(await readFile(filePath, "utf8")).toBe("before");
        expect((await loadChatSessionWithMessages(session.id)).messages).toHaveLength(2);

        const redone = await redoSessionTurn(session.id);
        expect(redone).toMatchObject({
          turnKey: "u2",
          restoredFiles: ["tracked.txt"],
          messageCount: 4,
        });
        expect(await readFile(filePath, "utf8")).toBe("after");
        expect((await loadChatSessionWithMessages(session.id)).messages).toHaveLength(4);
      } finally {
        await deleteChatSession(session.id).catch(() => undefined);
      }
    },
    20_000,
  );
});
