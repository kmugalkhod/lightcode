import { describe, expect, test } from "bun:test";
import { truncatePathLeft } from "./text-utils";

describe("truncatePathLeft", () => {
  test("returns the path unchanged when within the limit", () => {
    expect(truncatePathLeft("src/app.ts", 40)).toBe("src/app.ts");
  });

  test("truncates from the left keeping the tail visible", () => {
    const result = truncatePathLeft("a/very/deeply/nested/path/file.ts", 12);
    expect(result.length).toBe(12);
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("file.ts")).toBe(true);
  });

  test("uses an ASCII ellipsis when provided", () => {
    const result = truncatePathLeft("a/very/deeply/nested/path/file.ts", 12, "...");
    expect(result.length).toBe(12);
    expect(result.startsWith("...")).toBe(true);
    expect(result.endsWith("file.ts")).toBe(true);
  });
});
