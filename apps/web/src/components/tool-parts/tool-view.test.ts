import { describe, expect, test } from "bun:test";
import { countDiffLines, toolView, toolViewBadge } from "./tool-view";

const diff = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old line",
  "+new line",
  "+another",
].join("\n");

describe("tool views", () => {
  test("edits show a diff with +/- counts", () => {
    const view = toolView("edit_file", {
      path: "src/app.ts",
      replacements: 1,
      bytesWritten: 20,
      diff,
    });
    expect(view).toMatchObject({ kind: "diff", path: "src/app.ts", added: 2, removed: 1 });
    expect(toolViewBadge(view)).toBe("+2 −1");
    expect(countDiffLines(diff)).toEqual({ added: 2, removed: 1 });
  });

  test("bash shows the command and its exit code", () => {
    const view = toolView("bash", {
      command: "bun test",
      cwd: "/repo",
      stdout: "ok",
      stderr: "",
      exitCode: 1,
      truncated: false,
    });
    expect(view).toMatchObject({ kind: "command", command: "bun test", exitCode: 1 });
    expect(toolViewBadge(view)).toBe("exit 1");
  });

  test("search tools list paths with a count", () => {
    const grep = toolView("grep", {
      query: "TODO",
      path: ".",
      matches: [{ path: "a.ts", lineNumber: 3, column: 1, line: "  // TODO x" }],
      totalMatches: 1,
      truncated: false,
    });
    expect(grep).toMatchObject({ kind: "matches", items: ["a.ts:3  // TODO x"] });
    expect(toolViewBadge(grep)).toBe("1 match");

    const glob = toolView("glob_search", {
      pattern: "**/*.ts",
      path: ".",
      matches: [{ path: "a.ts", type: "file", size: 1 }],
      totalMatches: 120,
      truncated: true,
    });
    expect(toolViewBadge(glob)).toBe("120+ files");
  });

  test("unknown tools and unexpected payloads fall back to the generic view", () => {
    expect(toolView("web_fetch", { url: "x" })).toEqual({ kind: "generic" });
    expect(toolView("bash", { command: 1 })).toEqual({ kind: "generic" });
    expect(toolView("edit_file", { path: "a", diff: "" })).toEqual({ kind: "generic" });
    expect(toolViewBadge({ kind: "generic" })).toBeNull();
  });
});
