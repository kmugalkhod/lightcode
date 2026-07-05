import { describe, expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "./fuzzy-match";

describe("fuzzyScore", () => {
  test("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "apps/cli/src/index.tsx")).toBeNull();
  });

  test("empty query matches everything with a neutral score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  test("literal substring in the file name beats a scattered subsequence", () => {
    const substringScore = fuzzyScore(
      "approval",
      "apps/cli/src/components/chat/chat-tool-approval-card.tsx",
    );
    const scatteredScore = fuzzyScore(
      "approval",
      "apps/server/src/lib/chat-observability.ts",
    );

    expect(substringScore).not.toBeNull();
    expect(scatteredScore).not.toBeNull();
    expect(substringScore!).toBeGreaterThan(scatteredScore!);
  });
});

describe("fuzzyFilter", () => {
  test("ranks files actually named after the query above scattered matches", () => {
    const candidates = [
      "apps/server/src/lib/chat-observability.ts",
      "apps/server/src/lib/chat-observability.test.ts",
      "packages/ai/src/coding-agent-approval-flow.test.ts",
      "apps/cli/src/components/chat/chat-tool-approval-card.tsx",
    ];

    const results = fuzzyFilter("approval", candidates);
    expect(results.slice(0, 2).sort()).toEqual(
      [
        "apps/cli/src/components/chat/chat-tool-approval-card.tsx",
        "packages/ai/src/coding-agent-approval-flow.test.ts",
      ].sort(),
    );
  });

  test("limits results", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => `file-${i}.ts`);
    expect(fuzzyFilter("file", candidates, 6)).toHaveLength(6);
  });
});
