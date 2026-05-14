import type { TextareaRenderable } from "@opentui/core";
import { useRef } from "react";
import { SlashPageMenu } from "../commands/slash-page-menu";
import { getSlashPageRoutes } from "../navigation/route-registry";
import { useAppState } from "../state/app-state";

export function HomeTextArea() {
  const {
    slashMenuOpen,
    slashMenuQuery,
    setSlashMenuQuery,
    slashMenuSelected,
    setSlashMenuSelected,
    submitPrompt,
    navigate,
  } = useAppState();

  const textareaRef = useRef<TextareaRenderable>(null);
  const lastManualNewlineAt = useRef(0);
  const slashRoutes = getSlashPageRoutes(slashMenuQuery);
  const selectedIndex = Math.min(slashMenuSelected, Math.max(slashRoutes.length - 1, 0));

  return (
    <box
      width="66%"
      maxWidth={104}
      minWidth={64}
      flexDirection="column"
    >
      {slashMenuOpen && (
        <SlashPageMenu
          query={slashMenuQuery}
          setQuery={(query) => {
            setSlashMenuQuery(query);
            setSlashMenuSelected(0);
          }}
          selectedIndex={selectedIndex}
          routes={slashRoutes}
        />
      )}

      <box
        height={7}
        flexDirection="row"
        backgroundColor="#1E1E1E"
      >
        <box width={1} height="100%" backgroundColor="#22D3EE" />
        <box flexGrow={1} flexDirection="column" gap={1} paddingX={3} paddingY={1}>
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
              if (Date.now() - lastManualNewlineAt.current < 100) {
                return;
              }

              const text = textareaRef.current?.plainText ?? "";
              submitPrompt(text);
              navigate("chat", { state: { input: text } });
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
            placeholder={'Ask anything... "What is the tech stack of this project?"'}
            width="100%"
            height={2}
            wrapMode="word"
            backgroundColor="#1E1E1E"
            focusedBackgroundColor="#1E1E1E"
            textColor="#FFFFFF"
            cursorColor="#FFFFFF"
            placeholderColor="#8D8D8D"
            focused={!slashMenuOpen}
          />
          <text>
            <span fg="#22D3EE">Build</span>
            <span fg="#6B7280"> - </span>
            <span fg="#F8FAFC">GPT-5.5</span>
            <span fg="#8D8D8D"> OpenAI</span>
            <span fg="#6B7280"> - </span>
            <span fg="#F59E0B">high</span>
          </text>
        </box>
      </box>
    </box>
  );
}
