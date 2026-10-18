import { describe, expect, test } from "bun:test";
import { TypeValidationError } from "@ai-sdk/provider";
import { InvalidToolInputError, NoSuchToolError } from "ai";
import { editFileProviderInputSchema } from "./edit-file/schema";
import { formatToolErrorText, markToolExecutionError } from "./tool-error-text";

function invalidEditFileError(input: unknown) {
  const parsed = editFileProviderInputSchema.safeParse(input);
  if (parsed.success) {
    throw new Error("expected the edit_file input to be invalid");
  }
  return new InvalidToolInputError({
    toolName: "edit_file",
    toolInput: JSON.stringify(input),
    cause: TypeValidationError.wrap({ value: input, cause: parsed.error }),
  });
}

describe("formatToolErrorText", () => {
  test("names the missing field instead of echoing the whole payload", () => {
    // The real failure: the optional flag sent in place of the replacement.
    const search = "x".repeat(5_000);
    const text = formatToolErrorText(
      invalidEditFileError({ path: "app.js", replaceAll: false, search }),
    );

    expect(text).toBe(
      'Invalid input for edit_file: missing required field "replace". Resend the call with every required field.',
    );
    expect(text).not.toContain("LIGHTCODE_ERROR");
  });

  test("also handles the message-string form the SDK emits for tool output", () => {
    // The same failure arrives a second time as getErrorMessage(error).
    const error = invalidEditFileError({ path: "app.js", replaceAll: false, search: "old" });

    expect(formatToolErrorText(error.message)).toBe(
      'Invalid input for edit_file: missing required field "replace". Resend the call with every required field.',
    );
    expect(formatToolErrorText("Model tried to call unavailable tool 'edit'. Available tools: edit_file.")).toContain(
      "unavailable tool",
    );
  });

  test("reports type mismatches with their path", () => {
    const text = formatToolErrorText(
      invalidEditFileError({ path: "app.js", search: "a", replace: 42 }),
    );

    expect(text).toContain("replace:");
    expect(text).not.toContain("missing required field");
  });

  test("passes unknown-tool and tool execution errors through as plain text", () => {
    const unknownTool = new NoSuchToolError({
      toolName: "str_replace_based_edit",
      availableTools: ["edit_file"],
    });
    expect(formatToolErrorText(unknownTool)).toContain("str_replace_based_edit");

    const failedEdit = new Error("The search text matches 2 places.");
    markToolExecutionError(failedEdit);
    expect(formatToolErrorText(failedEdit)).toBe("The search text matches 2 places.");
  });

  test("leaves genuine stream errors to the chat error envelope", () => {
    expect(formatToolErrorText(new Error("socket hang up"))).toBeNull();
    expect(formatToolErrorText("boom")).toBeNull();
  });
});
