import { describe, expect, test } from "bun:test";
import { kindFromStatus } from "./use-git-changes";

describe("kindFromStatus (git porcelain XY → change kind)", () => {
  test("untracked when either side is '?'", () => {
    expect(kindFromStatus("?", "?")).toBe("untracked");
  });

  test("modified-unstaged ( M)", () => {
    expect(kindFromStatus("", "M")).toBe("modified");
  });

  test("added/staged (A )", () => {
    expect(kindFromStatus("A", "")).toBe("created");
  });

  test("deleted (D in either column)", () => {
    expect(kindFromStatus("", "D")).toBe("deleted");
    expect(kindFromStatus("D", "")).toBe("deleted");
  });

  test("renamed (R)", () => {
    expect(kindFromStatus("R", "")).toBe("renamed");
  });

  test("type-changed/copied fall back to modified", () => {
    expect(kindFromStatus("", "T")).toBe("modified");
    expect(kindFromStatus("C", "")).toBe("modified");
  });

  test("prefers the working-tree column over the index column", () => {
    // staged-add then deleted-in-worktree reads as deleted (worktree wins).
    expect(kindFromStatus("A", "D")).toBe("deleted");
  });
});
