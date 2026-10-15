import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage } from "./chat-message";

function assistantWithTool(part: Record<string, unknown>): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "Done." }, part as UIMessage["parts"][number]],
  };
}

describe("ChatMessage tool calls", () => {
  test("an edit shows a +/- badge and a coloured diff, with JSON behind Details", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantWithTool({
          type: "tool-edit_file",
          toolCallId: "t1",
          state: "output-available",
          input: { path: "src/app.ts", search: "old", replace: "new" },
          output: {
            path: "src/app.ts",
            replacements: 1,
            bytesWritten: 3,
            diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        })}
      />,
    );
    expect(html).toContain("+1 −1");
    expect(html).toContain('class="diff-line removed"');
    expect(html).toContain('class="diff-line added"');
    expect(html).toContain("<summary>Details</summary>");
  });

  test("a failing command is flagged in its badge", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantWithTool({
          type: "tool-bash",
          toolCallId: "t2",
          state: "output-available",
          input: { command: "bun test" },
          output: {
            command: "bun test",
            cwd: "/repo",
            stdout: "",
            stderr: "1 fail",
            exitCode: 1,
            truncated: false,
          },
        })}
      />,
    );
    expect(html).toContain('class="tool-badge failed"');
    expect(html).toContain("exit 1");
    expect(html).toContain("1 fail");
  });

  test("unknown tools keep the raw input and result view", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={assistantWithTool({
          type: "tool-web_fetch",
          toolCallId: "t3",
          state: "output-available",
          input: { url: "https://example.com" },
          output: { status: 200 },
        })}
      />,
    );
    expect(html).toContain("Result");
    expect(html).not.toContain("tool-badge");
  });
});
