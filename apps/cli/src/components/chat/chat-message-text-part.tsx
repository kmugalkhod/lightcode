import { SyntaxStyle } from "@opentui/core";
import type { TextUIPart } from "ai";
import { cliTheme } from "../../ui/cli-theme";
import {
  ChatProposedPlanCard,
  splitProposedPlanBlocks,
} from "./chat-proposed-plan-card";

interface ChatMessageTextPartProps {
  part: TextUIPart;
}

const markdownSyntaxStyle = SyntaxStyle.create();

function renderMarkdown(content: string, key: string) {
  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return null;
  }

  return (
    <markdown
      key={key}
      width="100%"
      content={trimmedContent}
      syntaxStyle={markdownSyntaxStyle}
      streaming
      tableOptions={{
        widthMode: "full",
        wrapMode: "word",
        cellPadding: 1,
        borders: true,
        outerBorder: true,
        borderStyle: "single",
        borderColor: cliTheme.markdown.tableBorder,
        selectable: true,
      }}
    />
  );
}

export function ChatMessageTextPart({ part }: ChatMessageTextPartProps) {
  if (!part.text) {
    return null;
  }

  const segments = splitProposedPlanBlocks(part.text);
  const renderedSegments = segments
    .map((segment, index) => {
      const key = `${segment.type}:${index}`;

      if (segment.type === "plan") {
        return <ChatProposedPlanCard key={key} content={segment.text} />;
      }

      return renderMarkdown(segment.text, key);
    })
    .filter((segment): segment is NonNullable<typeof segment> => segment !== null);

  if (renderedSegments.length === 0) {
    return null;
  }

  return (
    <box width="100%" flexDirection="column" gap={1}>
      {renderedSegments}
    </box>
  );
}
