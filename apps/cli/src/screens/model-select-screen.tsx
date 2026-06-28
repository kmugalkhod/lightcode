import { TextAttributes, typeRole } from "../ui/cli-theme";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ModelSelector } from "../components/chat/model-selector";
import { cliTheme } from "../ui/cli-theme";

/**
 * Full-page host for the OpenRouter model picker so /model works from the
 * home screen as well as inside a chat session. Esc (or a successful switch)
 * returns to the previous screen.
 */
export function ModelSelectScreen() {
  const navigate = useNavigate();
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(
    null,
  );

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1} paddingX={1}>
      <text {...typeRole("title")}>Switch Model</text>
      {notice ? (
        <text
          fg={
            notice.tone === "error"
              ? cliTheme.semantic.error
              : cliTheme.accent.primary
          }
        >
          {notice.text}
        </text>
      ) : null}
      <ModelSelector
        notify={(text, tone = "info") => setNotice({ text, tone })}
        onClose={() => navigate(-1)}
      />
    </box>
  );
}
