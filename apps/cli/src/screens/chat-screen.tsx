import { useChat } from "@ai-sdk/react";
import type { TextareaRenderable } from "@opentui/core";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef } from "react";
import type { ScreenProps } from "../navigation/route-registry";
import { chatRouteStateSchema } from "../navigation/route-state";

const apiBaseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://localhost:3000";
const llmApiUrl = `${apiBaseUrl}/llm`;

export function ChatScreen({ routeState }: ScreenProps) {
  const parsedRouteState = useMemo(() => chatRouteStateSchema.safeParse(routeState), [routeState]);
  const initialPrompt = parsedRouteState.success ? parsedRouteState.data.input.trim() : "";
  const submittedInitialPromptRef = useRef<string | null>(null);
  const textareaRef = useRef<TextareaRenderable>(null);
  const lastManualNewlineAt = useRef(0);
  const { messages, sendMessage, error, status } = useChat({
    transport: new DefaultChatTransport({
      api: llmApiUrl,
    }),
  });
  const isLoading = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (!initialPrompt || submittedInitialPromptRef.current === initialPrompt) {
      return;
    }

    submittedInitialPromptRef.current = initialPrompt;
    void sendMessage({ text: initialPrompt });
  }, [initialPrompt, sendMessage]);

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      paddingX={2}
      paddingY={1}
    >
      <text fg="#8D8D8D">Conversation</text>
      <box
        flexGrow={1}
        flexDirection="column"
        gap={1}
        borderStyle="single"
        borderColor="#2B2B2B"
        padding={1}
      >
        {messages.length === 0 ? <text fg="#8D8D8D">No messages yet.</text> : null}
        {messages.map((message) => (
          <box key={message.id} flexDirection="column">
            <text fg={message.role === "user" ? "#22D3EE" : "#A3E635"}>
              {message.role === "user" ? "You" : "Assistant"}
            </text>
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <text key={`${message.id}:text:${index}`}>{part.text}</text>
              ) : null
            )}
          </box>
        ))}
        {isLoading ? <text fg="#8D8D8D">Thinking...</text> : null}
      </box>
      {error ? <text fg="#EF4444">{error.message}</text> : null}
      <text fg="#8D8D8D">Message</text>
      <box height={4} flexDirection="row" backgroundColor="#1E1E1E">
        <box width={1} height="100%" backgroundColor="#22D3EE" />
        <box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1}>
          <textarea
            ref={textareaRef}
            initialValue=""
            onKeyDown={(event: any) => {
              const isEnterLike =
                event.name === "return" ||
                event.name === "enter" ||
                event.name === "linefeed";

              if (isEnterLike && (event.ctrl || event.name === "linefeed")) {
                event.preventDefault();
                lastManualNewlineAt.current = Date.now();
                textareaRef.current?.newLine();
              }
            }}
            onSubmit={() => {
              if (Date.now() - lastManualNewlineAt.current < 100 || isLoading) {
                return;
              }

              const text = textareaRef.current?.plainText.trim() ?? "";
              if (!text) {
                return;
              }

              void sendMessage({ text });
              textareaRef.current?.setText("");
            }}
            keyBindings={[
              { name: "return", ctrl: true, action: "newline" },
              { name: "enter", ctrl: true, action: "newline" },
              { name: "linefeed", ctrl: true, action: "newline" },
              { name: "linefeed", action: "newline" },
              { name: "return", action: "submit" },
              { name: "enter", action: "submit" },
            ]}
            placeholder={isLoading ? "Waiting for response..." : "Reply..."}
            width="100%"
            height={2}
            wrapMode="word"
            backgroundColor="#1E1E1E"
            focusedBackgroundColor="#1E1E1E"
            textColor="#FFFFFF"
            cursorColor="#FFFFFF"
            placeholderColor="#8D8D8D"
            focused={!isLoading}
          />
        </box>
      </box>
    </box>
  );
}
