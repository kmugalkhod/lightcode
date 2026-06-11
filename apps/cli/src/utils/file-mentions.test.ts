import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendMentionAttachments, extractFileMentions } from "./file-mentions";
import { fuzzyFilter, fuzzyScore } from "./fuzzy-match";

describe("extractFileMentions", () => {
  test("finds @path tokens and strips trailing punctuation", () => {
    expect(
      extractFileMentions("Look at @src/app.ts and @README.md, please"),
    ).toEqual(["src/app.ts", "README.md"]);
  });

  test("ignores emails and bare @", () => {
    // Emails don't match (the @ must follow whitespace) and a bare @ has no path.
    expect(extractFileMentions("mail me at user@example.com or @ alone")).toEqual([]);
  });

  test("dedupes repeated mentions", () => {
    expect(extractFileMentions("@a.ts then @a.ts again")).toEqual(["a.ts"]);
  });
});

describe("appendMentionAttachments", () => {
  test("appends fenced content for existing files and skips unknown paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lightcode-mentions-"));
    try {
      await writeFile(path.join(dir, "hello.ts"), "export const x = 1;\n", "utf8");

      const result = await appendMentionAttachments(
        "Explain @hello.ts and @missing.ts",
        dir,
      );

      expect(result).toContain("Attached file: hello.ts");
      expect(result).toContain("export const x = 1;");
      expect(result).not.toContain("Attached file: missing.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns the text unchanged without mentions", async () => {
    expect(await appendMentionAttachments("no mentions here", process.cwd())).toBe(
      "no mentions here",
    );
  });
});

describe("fuzzy matching", () => {
  test("requires a subsequence", () => {
    expect(fuzzyScore("xyz", "src/app.ts")).toBeNull();
    expect(fuzzyScore("app", "src/app.ts")).not.toBeNull();
  });

  test("ranks segment starts and consecutive runs higher", () => {
    const results = fuzzyFilter("app", [
      "src/wrapped.ts",
      "src/app.ts",
      "docs/appendix.md",
    ]);

    expect(results[0]).toBe("src/app.ts");
  });
});
