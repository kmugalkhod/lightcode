import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceContext } from "../common/resolve-within-workspace";
import { READ_FILE_OUTPUT_CHARS } from "../constants";
import { executeReadFile } from "./runtime";

async function workspaceWith(name: string, content: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "lc-read-"));
  await writeFile(path.join(dir, name), content);
  return createWorkspaceContext(dir);
}

function numberedLines(count: number, width = 40) {
  return Array.from({ length: count }, (_, index) =>
    `line ${index + 1} `.padEnd(width, "x"),
  ).join("\n");
}

describe("executeReadFile", () => {
  test("returns a typical source file whole in one call", async () => {
    // ~500 lines of 40 chars: the size that used to take four reads.
    const content = numberedLines(500);
    const workspace = await workspaceWith("big.ts", content);

    const result = await executeReadFile({ path: "big.ts" }, workspace);

    expect(result.content).toBe(content);
    expect(result.endLine).toBe(500);
    expect(result.truncated).toBe(false);
    expect(result.nextStartLine).toBeUndefined();
  });

  test("stops at a whole line and says where to continue", async () => {
    const workspace = await workspaceWith("huge.ts", numberedLines(2_000));

    const first = await executeReadFile({ path: "huge.ts" }, workspace);

    expect(first.truncated).toBe(true);
    expect(first.content.length).toBeLessThanOrEqual(READ_FILE_OUTPUT_CHARS);
    expect(first.content).not.toContain("characters omitted");
    expect(first.content.split("\n").at(-1)).toBe(
      `line ${first.endLine} `.padEnd(40, "x"),
    );
    expect(first.nextStartLine).toBe(first.endLine + 1);

    const second = await executeReadFile(
      { path: "huge.ts", startLine: first.nextStartLine },
      workspace,
    );
    expect(second.startLine).toBe(first.endLine + 1);
    expect(second.content.startsWith(`line ${first.endLine + 1} `)).toBe(true);
  });

  test("an explicit range within budget is returned exactly", async () => {
    const workspace = await workspaceWith("huge.ts", numberedLines(2_000));

    const result = await executeReadFile(
      { path: "huge.ts", startLine: 900, endLine: 1_100 },
      workspace,
    );

    expect(result.startLine).toBe(900);
    expect(result.endLine).toBe(1_100);
    expect(result.truncated).toBe(false);
    expect(result.nextStartLine).toBeUndefined();
  });

  test("cuts within a single line only when it alone exceeds the budget", async () => {
    const workspace = await workspaceWith(
      "bundle.min.js",
      `${"m".repeat(READ_FILE_OUTPUT_CHARS * 2)}\nsecond line`,
    );

    const result = await executeReadFile({ path: "bundle.min.js" }, workspace);

    expect(result.endLine).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(READ_FILE_OUTPUT_CHARS);
    expect(result.nextStartLine).toBe(2);
  });
});
