import { describe, expect, test } from "bun:test";
import { commandFailed, countDiffLines, toolView, toolViewBadge } from "./tool-view";

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

  test("background jobs show their state instead of a failed exit", () => {
    const started = toolView("bash", {
      command: "bun run dev",
      cwd: "/repo",
      stdout: "",
      stderr: "",
      exitCode: null,
      truncated: false,
      backgroundJobId: "bash-1",
      message: "Started in the background as bash-1.",
    });
    expect(started).toMatchObject({ kind: "command", status: "running", note: "Started in the background as bash-1" });
    expect(toolViewBadge(started)).toBe("running");
    expect(commandFailed(started)).toBe(false);

    const report = { jobId: "bash-1", command: "bun run dev", stdout: "ready", stderr: "", truncated: false };
    const stopped = toolView("bash_stop", { ...report, status: "stopped", exitCode: 1 });
    expect(toolViewBadge(stopped)).toBe("stopped");
    expect(commandFailed(stopped)).toBe(false);

    const crashed = toolView("bash_output", { ...report, status: "exited", exitCode: 2 });
    expect(toolViewBadge(crashed)).toBe("exit 2");
    expect(commandFailed(crashed)).toBe(true);
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
