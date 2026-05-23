import { SyntaxStyle } from "@opentui/core";
import type { TextUIPart } from "ai";

interface ChatMessageTextPartProps {
  part: TextUIPart;
}

const markdownSyntaxStyle = SyntaxStyle.create();

export function ChatMessageTextPart({ part }: ChatMessageTextPartProps) {
  if (!part.text) {
    return null;
  }

  return (
    <markdown
      width="100%"
      content={part.text}
      syntaxStyle={markdownSyntaxStyle}
      streaming
      tableOptions={{
        widthMode: "full",
        wrapMode: "word",
        cellPadding: 1,
        borders: true,
        outerBorder: true,
        borderStyle: "single",
        borderColor: "#334155",
        selectable: true,
      }}
    />
  );
}
