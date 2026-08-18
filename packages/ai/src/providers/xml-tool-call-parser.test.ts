import { describe, expect, test } from "bun:test";
import {
  bareToolCallMarkerHoldbackLength,
  confirmBareToolCallCandidate,
  extractToolCalls,
  findLeadingJsonObjectEnd,
} from "./xml-tool-call-parser";

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

describe("bare JSON streaming detection", () => {
  test("confirms only advertised tool names", () => {
    expect(
      confirmBareToolCallCandidate(
        '{"name": "read_file", "arguments": {',
        ["read_file"],
      ),
    ).toBe("confirmed");
    expect(
      confirmBareToolCallCandidate('{"name": "package", "version": "1"}', [
        "read_file",
      ]),
    ).toBe("rejected");
  });

  test("holds split prefixes and locates a complete leading object", () => {
    expect(bareToolCallMarkerHoldbackLength('text {"na')).toBe(4);
    const json = '{"name":"read_file","arguments":{"path":"a.ts"}}';
    expect(findLeadingJsonObjectEnd(`${json}\nmore`)).toBe(json.length);
    expect(findLeadingJsonObjectEnd(json.slice(0, -1))).toBe(-1);
  });
});
