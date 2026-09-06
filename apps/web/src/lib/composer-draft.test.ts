import { describe, expect, test } from "bun:test";
import { readComposerDraft, saveComposerDraft } from "./composer-draft";
import type { StorageLike } from "./api";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

describe("composer drafts", () => {
  test("isolates drafts by session and preserves multiline Unicode", () => {
    const storage = memoryStorage();
    saveComposerDraft("one", "Review\nनमस्ते 🔎", storage);
    saveComposerDraft("two", "Another task", storage);
    expect(readComposerDraft("one", storage)).toBe("Review\nनमस्ते 🔎");
    expect(readComposerDraft("two", storage)).toBe("Another task");
    expect(readComposerDraft("missing", storage)).toBe("");
  });
  test("clears only the submitted draft", () => {
    const storage = memoryStorage();
    saveComposerDraft("one", "Task", storage);
    saveComposerDraft("two", "Keep", storage);
    saveComposerDraft("one", "", storage);
    expect(storage.getItem("lightcode.web.draft.one")).toBeNull();
    expect(readComposerDraft("two", storage)).toBe("Keep");
  });
  test("rejects corrupted, non-string, and oversized persisted input", () => {
    const storage = memoryStorage();
    for (const value of ["bad JSON", "null", "{}", JSON.stringify("x".repeat(100_001))]) {
      storage.setItem("lightcode.web.draft.one", value);
      expect(readComposerDraft("one", storage)).toBe("");
    }
  });
  test("storage failures never prevent editing", () => {
    const fail = () => { throw new Error("Storage unavailable"); };
    const storage: StorageLike = { getItem: fail, setItem: fail, removeItem: fail };
    expect(readComposerDraft("one", storage)).toBe("");
    expect(() => saveComposerDraft("one", "Task", storage)).not.toThrow();
    expect(() => saveComposerDraft("one", "", storage)).not.toThrow();
  });
});
