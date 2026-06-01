import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
  assertProviderToolSchemaBudget,
  collectToolSchemaPreflight,
} from "@lightcode/ai";

describe("provider-facing tool schema preflight", () => {
  test("all tool input schemas compile to top-level JSON object input_schema", () => {
    const entries = collectToolSchemaPreflight();

    for (const entry of entries) {
      expect(entry.inputSchemaType).toBe("object");
    }
  });

  test("all tool schemas stay within optional parameter budget", () => {
    const entries = collectToolSchemaPreflight();

    for (const entry of entries) {
      expect(entry.optionalPropertyCount).toBeLessThanOrEqual(
        ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
      );
    }

    expect(() => assertProviderToolSchemaBudget()).not.toThrow();
  });
});
