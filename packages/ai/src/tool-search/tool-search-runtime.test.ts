import { describe, expect, test } from "bun:test";
import { executeCodingTool } from "../runtime-registry";

describe("tool_search runtime", () => {
  test("searches discoverable tool metadata", async () => {
    const output = await executeCodingTool(
      "tool_search",
      {
        query: "git diff repository changes",
        maxResults: 5,
      },
      {
        cwd: process.cwd(),
        mode: "plan",
        permissionMode: "read-only",
      },
    );

    expect(output.results.some((result) => result.name === "git_diff")).toBe(true);
    expect(output.results.every((result) => result.score > 0)).toBe(true);
  });
});
