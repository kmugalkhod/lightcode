import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  collectChangedFiles,
  getMostRecentChangedFile,
} from "./use-changed-files";

const SAMPLE_DIFF = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  "+const z = 4;",
].join("\n");

/** Build an assistant message whose parts are the given tool parts. */
function assistantMessage(id: string, parts: unknown[]): UIMessage {
  return {
    id,
    role: "assistant",
    parts: parts as UIMessage["parts"],
  } as UIMessage;
}

function completedEdit(
  toolCallId: string,
  path: string,
  diff: string,
  extraOutput: Record<string, unknown> = {},
) {
  return {
    type: "tool-edit_file",
    toolCallId,
    state: "output-available",
    input: { path },
    output: { path, diff, ...extraOutput },
  };
}

function streamingEdit(toolCallId: string, path: string, toolName = "edit_file") {
  return {
    type: `tool-${toolName}`,
    toolCallId,
    state: "input-streaming",
    input: { path },
  };
}

describe("collectChangedFiles", () => {
  test("returns empty list when there are no edits", () => {
    const messages = [
      assistantMessage("m1", [
        { type: "text", text: "hello" },
        {
          type: "tool-read_file",
          toolCallId: "t0",
          state: "output-available",
          input: { path: "src/app.ts" },
          output: { content: "..." },
        },
      ]),
    ];
    expect(collectChangedFiles(messages)).toEqual([]);
  });

  test("collects a completed edit with correct +/- counts", () => {
    const messages = [
      assistantMessage("m1", [completedEdit("t1", "src/app.ts", SAMPLE_DIFF)]),
    ];

    const files = collectChangedFiles(messages);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/app.ts",
      addedLines: 2,
      removedLines: 1,
      status: "done",
      changeKind: "modified",
      lastToolPartId: "t1",
    });
  });

  test("preserves first-touched order across messages", () => {
    const messages = [
      assistantMessage("m1", [completedEdit("t1", "b.ts", SAMPLE_DIFF)]),
      assistantMessage("m2", [completedEdit("t2", "a.ts", SAMPLE_DIFF)]),
      assistantMessage("m3", [completedEdit("t3", "c.ts", SAMPLE_DIFF)]),
    ];

    expect(collectChangedFiles(messages).map((f) => f.path)).toEqual([
      "b.ts",
      "a.ts",
      "c.ts",
    ]);
  });

  test("dedupes by path keeping the latest diff while holding first order", () => {
    const firstDiff = SAMPLE_DIFF;
    const secondDiff = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    const messages = [
      assistantMessage("m1", [completedEdit("t1", "a.ts", firstDiff)]),
      assistantMessage("m2", [completedEdit("t2", "z.ts", SAMPLE_DIFF)]),
      assistantMessage("m3", [completedEdit("t3", "a.ts", secondDiff)]),
    ];

    const files = collectChangedFiles(messages);
    expect(files.map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
    const aFile = files[0];
    expect(aFile.diff).toBe(secondDiff);
    expect(aFile.addedLines).toBe(1);
    expect(aFile.removedLines).toBe(1);
    expect(aFile.lastToolPartId).toBe("t3");
  });

  test("surfaces in-flight edits as streaming from input path", () => {
    const messages = [
      assistantMessage("m1", [streamingEdit("t1", "src/new.ts", "write_file")]),
    ];

    const files = collectChangedFiles(messages);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/new.ts",
      status: "streaming",
      diff: "",
      addedLines: 0,
      removedLines: 0,
    });
  });

  test("keeps prior diff when a follow-up edit to the same file is streaming", () => {
    const messages = [
      assistantMessage("m1", [completedEdit("t1", "a.ts", SAMPLE_DIFF)]),
      assistantMessage("m2", [streamingEdit("t2", "a.ts")]),
    ];

    const files = collectChangedFiles(messages);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "a.ts",
      status: "streaming",
      addedLines: 2,
      removedLines: 1,
    });
    expect(files[0].diff).toBe(SAMPLE_DIFF);
  });

  test("labels write_file creations as created", () => {
    const messages = [
      assistantMessage("m1", [
        completedEdit("t1", "src/made.ts", SAMPLE_DIFF, { created: true }),
      ]),
    ];
    expect(collectChangedFiles(messages)[0].changeKind).toBe("created");
  });

  test("labels all-removed diffs as deleted", () => {
    const deletionDiff = [
      "--- a/gone.ts",
      "+++ b/gone.ts",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
    ].join("\n");

    const messages = [
      assistantMessage("m1", [completedEdit("t1", "gone.ts", deletionDiff)]),
    ];
    expect(collectChangedFiles(messages)[0].changeKind).toBe("deleted");
  });

  test("most-recent file follows the latest touch, not list order", () => {
    // b.ts is touched first, then a.ts, then b.ts again — b.ts is newest even
    // though a.ts comes later in first-touched order.
    const messages = [
      assistantMessage("m1", [completedEdit("t1", "b.ts", SAMPLE_DIFF)]),
      assistantMessage("m2", [completedEdit("t2", "a.ts", SAMPLE_DIFF)]),
      assistantMessage("m3", [completedEdit("t3", "b.ts", SAMPLE_DIFF)]),
    ];

    const files = collectChangedFiles(messages);
    expect(files.map((f) => f.path)).toEqual(["b.ts", "a.ts"]);
    expect(getMostRecentChangedFile(files)?.path).toBe("b.ts");
  });

  test("getMostRecentChangedFile returns null for an empty list", () => {
    expect(getMostRecentChangedFile([])).toBeNull();
  });

  test("ignores non-edit tools", () => {
    const messages = [
      assistantMessage("m1", [
        {
          type: "tool-bash",
          toolCallId: "t1",
          state: "output-available",
          input: { command: "ls" },
          output: { stdout: "a.ts" },
        },
      ]),
    ];
    expect(collectChangedFiles(messages)).toEqual([]);
  });
});
