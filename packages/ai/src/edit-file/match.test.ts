import { describe, expect, test } from "bun:test";
import { applyEdit, EditMatchError } from "./match";

describe("applyEdit", () => {
  test("exact LF match (fast path)", () => {
    const original = "const a = 1;\nconst b = 2;\n";
    const result = applyEdit(original, "const b = 2;", "const b = 3;", false);
    expect(result.strategy).toBe("exact");
    expect(result.replacements).toBe(1);
    expect(result.updatedContent).toBe("const a = 1;\nconst b = 3;\n");
  });

  test("edits a CRLF file without introducing stray LF endings", () => {
    const original = "line one\r\nline two\r\nline three\r\n";
    // A single-line search has no newline to mismatch, so the exact tier handles
    // it — but it must still preserve the file's CRLF endings.
    const result = applyEdit(original, "line two", "line TWO", false);
    expect(result.updatedContent).toBe("line one\r\nline TWO\r\nline three\r\n");
    // No bare LF (every \n is preceded by \r).
    expect(/[^\r]\n/.test(result.updatedContent)).toBe(false);
  });

  test("matches a multi-line LF search against a CRLF file", () => {
    const original = "function f() {\r\n  return 1;\r\n}\r\n";
    const result = applyEdit(
      original,
      "function f() {\n  return 1;\n}",
      "function f() {\n  return 2;\n}",
      false,
    );
    expect(result.updatedContent).toBe("function f() {\r\n  return 2;\r\n}\r\n");
  });

  test("tolerates trailing-whitespace drift (search has spaces the file lacks)", () => {
    const original = "const x = 1;\nconst y = 2;\n";
    // The model's search carries trailing whitespace not present in the file, so
    // it is not an exact substring — the flexible tier must absorb it.
    const result = applyEdit(original, "const x = 1;   ", "const x = 9;", false);
    expect(result.strategy).toBe("whitespace-flexible");
    expect(result.updatedContent).toBe("const x = 9;\nconst y = 2;\n");
  });

  test("tolerates leading-indentation drift (search over-indented vs file)", () => {
    const original = "if (ok) {\n  doThing();\n}\n"; // 2-space indent in file
    // Model over-indented its search to 4 spaces, so it is not a substring.
    const result = applyEdit(original, "    doThing();", "    doOther();", false);
    expect(result.strategy).toBe("whitespace-flexible");
    expect(result.updatedContent).toBe("if (ok) {\n    doOther();\n}\n");
  });

  test("throws on ambiguous match without replaceAll", () => {
    const original = "x();\nx();\n";
    expect(() => applyEdit(original, "x();", "y();", false)).toThrow(
      EditMatchError,
    );
    expect(() => applyEdit(original, "x();", "y();", false)).toThrow(/2 places/);
  });

  test("replaceAll changes every occurrence and counts them", () => {
    const original = "a;\r\na;\r\na;\r\n";
    const result = applyEdit(original, "a;", "b;", true);
    expect(result.replacements).toBe(3);
    expect(result.updatedContent).toBe("b;\r\nb;\r\nb;\r\n");
  });

  test("no match throws a descriptive error", () => {
    const original = "hello world\n";
    expect(() => applyEdit(original, "goodbye world", "x", false)).toThrow(
      /re-read the file/i,
    );
  });

  test("treats $ in the replacement literally", () => {
    const original = "const price = 0;\n";
    const result = applyEdit(original, "0", "$100", false);
    expect(result.updatedContent).toBe("const price = $100;\n");
  });
});
