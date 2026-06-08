import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { prepareChatMessagesForProvider } from "./context-optimization";
import { defaultContextOptimizerConfig } from "@lightcode/ai";

function textMessage(
  role: UIMessage["role"],
  text: string,
  id: string,
): UIMessage {
  return {
    id,
    role,
    parts: [
      {
        type: "text",
        text,
      },
    ],
  };
}

describe("server context optimization", () => {
  test("compacts large chat histories before provider handoff", () => {
    const messages = [
      textMessage("user", "Older request", "u1"),
      textMessage("assistant", "Older response", "a1"),
      textMessage("user", "Recent request", "u2"),
      textMessage("assistant", "Recent response", "a2"),
      textMessage("user", "Latest request", "u3"),
    ];

    const result = prepareChatMessagesForProvider({
      messages,
      contextConfig: {
        ...defaultContextOptimizerConfig,
        maxInputTokens: 1,
        preserveRecentMessages: 2,
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages.at(-2)?.id).toBe("a2");
    expect(result.messages.at(-1)?.id).toBe("u3");
  });

  test("skips provider handoff compaction while interactions are pending", () => {
    const messages = [
      textMessage("user", "Older request", "u1"),
      textMessage("assistant", "Older response", "a1"),
      textMessage("user", "Recent request", "u2"),
    ];

    const result = prepareChatMessagesForProvider({
      messages,
      contextConfig: {
        ...defaultContextOptimizerConfig,
        maxInputTokens: 1,
      },
      pendingInteractionCount: 1,
    });

    expect(result.compacted).toBe(false);
    expect(result.skipReason).toBe("pending_interactions");
    expect(result.messages).toHaveLength(messages.length);
  });
});

