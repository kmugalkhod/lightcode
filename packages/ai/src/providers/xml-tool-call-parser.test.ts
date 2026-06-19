import { describe, expect, test } from "bun:test";
import { extractToolCalls } from "./xml-tool-call-parser";

describe("extractToolCalls — function_calls wrapper", () => {
  test("parses the inner invoke and leaves no wrapper residue", async () => {
    const text =
      'Let me look.\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">src/app.tsx</parameter>\n</invoke>\n</function_calls>';
    const result = await extractToolCalls(text);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].toolName).toBe("read_file");
    expect(JSON.parse(result.calls[0].input)).toEqual({ path: "src/app.tsx" });
    // The wrapper tags must not leak into the visible text.
    expect(result.cleanText).not.toContain("<function_calls>");
    expect(result.cleanText).not.toContain("</function_calls>");
    expect(result.cleanText).toBe("Let me look.");
  });

  test("strips a bare wrapper with no inner call", async () => {
    const result = await extractToolCalls("done</function_calls>");
    expect(result.cleanText).toBe("done");
    expect(result.calls).toHaveLength(0);
  });
});
