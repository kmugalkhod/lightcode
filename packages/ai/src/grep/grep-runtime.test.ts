import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceContext } from "../common/resolve-within-workspace";
import { createGlobFilter, executeGrep } from "./runtime";

let root = "";

async function put(relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lightcode-grep-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await put(".gitignore", "generated/\n");
  await put("src/a.ts", ["import x from 'x';", "", "export function useWidget() {", "  return x;", "}", "// useWidget again"].join("\n"));
  await put("src/b.tsx", "export const view = useWidget();\n");
  await put("src/a.test.ts", "test('useWidget', () => useWidget());\n");
  await put("generated/out.ts", "useWidget();\n");
  await put("minified.js", `const a=1;${"x".repeat(5_000)}useWidget();\n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function grep(input: Parameters<typeof executeGrep>[0]) {
  return executeGrep(input, createWorkspaceContext(root));
}

describe("grep", () => {
  test("adds lines before and after each match when context is asked for", async () => {
    const result = await grep({ query: "export function useWidget", path: "src", context: 2 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      path: "src/a.ts",
      lineNumber: 3,
      before: ["import x from 'x';", ""],
      after: ["  return x;", "}"],
    });
  });

  test("glob limits the files searched, by name or by path, and can exclude", async () => {
    const paths = async (glob: string) =>
      [...new Set((await grep({ query: "useWidget", path: ".", glob })).matches.map((match) => match.path))].sort();
    expect(await paths("*.tsx")).toEqual(["src/b.tsx"]);
    expect(await paths("src/**/*.ts")).toEqual(["src/a.test.ts", "src/a.ts"]);
    expect(await paths("!*.test.ts")).not.toContain("src/a.test.ts");
  });

  test('outputMode "files" lists matching files with counts, most matches first', async () => {
    const result = await grep({ query: "useWidget", path: "src", outputMode: "files" });
    expect(result.matches).toEqual([]);
    expect(result.files).toEqual([
      { path: "src/a.test.ts", count: 1 },
      { path: "src/a.ts", count: 2 },
      { path: "src/b.tsx", count: 1 },
    ].sort((left, right) => right.count - left.count || left.path.localeCompare(right.path)));
    expect(result.totalMatches).toBe(4);
  });

  test("skips .gitignore'd files unless their folder is searched by name", async () => {
    const everywhere = await grep({ query: "useWidget", path: ".", outputMode: "files" });
    expect(everywhere.files?.map((file) => file.path)).not.toContain("generated/out.ts");
    const inside = await grep({ query: "useWidget", path: "generated" });
    expect(inside.matches.map((match) => match.path)).toEqual(["generated/out.ts"]);
  });

  test("clips very long lines", async () => {
    const result = await grep({ query: "useWidget", path: "minified.js" });
    expect(result.matches[0]?.line.length).toBeLessThan(1_100);
    expect(result.matches[0]?.line).toEndWith("[line truncated]");
  });

  test("reports truncation only when there were more matches", async () => {
    const exact = await grep({ query: "useWidget", path: "src/a.ts", maxResults: 2 });
    expect(exact.matches).toHaveLength(2);
    expect(exact.truncated).toBe(false);
    const more = await grep({ query: "useWidget", path: "src", maxResults: 2 });
    expect(more.matches).toHaveLength(2);
    expect(more.truncated).toBe(true);
  });

  test("regex search and a clear error for an invalid one", async () => {
    const result = await grep({ query: "use[A-Z]\\w+\\(\\)", path: "src/b.tsx", isRegex: true });
    expect(result.matches).toHaveLength(1);
    await expect(grep({ query: "use(", path: "src", isRegex: true })).rejects.toThrow();
  });

  test("glob filter semantics match ripgrep's", () => {
    expect(createGlobFilter("*.ts")("deep/nested/file.ts")).toBe(true);
    expect(createGlobFilter("*.ts")("deep/nested/file.tsx")).toBe(false);
    expect(createGlobFilter("src/**/*.{ts,tsx}")("src/a/b.tsx")).toBe(true);
    expect(createGlobFilter("src/**/*.{ts,tsx}")("lib/b.tsx")).toBe(false);
    expect(createGlobFilter("!*.test.ts")("src/a.test.ts")).toBe(false);
    expect(createGlobFilter(undefined)("anything")).toBe(true);
  });
});
