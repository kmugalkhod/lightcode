import { TextAttributes } from "@opentui/core";
import type { UIMessage } from "ai";
import { cliTheme } from "../../ui/cli-theme";
import { stripTrailingPeriod, truncateInline } from "../../utils/text-utils";

interface ParsedContextSummary {
  scopeLine?: string;
  metadataLines: string[];
}

function parseContextSummary(text: string): ParsedContextSummary {
  let scopeLine: string | undefined;
  const metadataLines: string[] = [];

  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    const scopeMatch = trimmed.match(/^- Scope:\s*(.+)$/i);
    if (scopeMatch) {
      scopeLine = truncateInline(`Scope: ${stripTrailingPeriod(scopeMatch[1])}`);
      continue;
    }

    const keyFilesMatch = trimmed.match(/^- Key files referenced:\s*(.+)$/i);
    if (keyFilesMatch) {
      metadataLines.push(
        truncateInline(`Files: ${stripTrailingPeriod(keyFilesMatch[1])}`),
      );
      continue;
    }

    const toolsMatch = trimmed.match(/^- Tools used:\s*(.+)$/i);
    if (toolsMatch) {
      metadataLines.push(
        truncateInline(`Tools: ${stripTrailingPeriod(toolsMatch[1])}`),
      );
      continue;
    }

    const currentWorkMatch = trimmed.match(/^- Current work:\s*(.+)$/i);
    if (currentWorkMatch) {
      metadataLines.push(
        truncateInline(`Current work: ${stripTrailingPeriod(currentWorkMatch[1])}`),
      );
    }
  }

  return {
    scopeLine,
    metadataLines: metadataLines.slice(0, 2),
  };
}

function extractFirstTextPart(message: UIMessage): string | null {
  for (const part of message.parts) {
    if (part.type === "text") {
      return part.text;
    }
  }
  return null;
}

function isContextSummaryMessage(message: UIMessage): boolean {
  if (message.role !== "system") {
    return false;
  }

  const firstText = extractFirstTextPart(message);
  if (!firstText) {
    return false;
  }

  return firstText.trim().toLowerCase().startsWith("lightcode context summary");
}

interface ChatContextSummaryCardProps {
  message: UIMessage;
}

export function ChatContextSummaryCard({ message }: ChatContextSummaryCardProps) {
  const firstText = extractFirstTextPart(message);
  if (!firstText) {
    return null;
  }

  const parsed = parseContextSummary(firstText);

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={cliTheme.semantic.info}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <text fg={cliTheme.semantic.info} attributes={TextAttributes.BOLD}>
        Context compacted
      </text>

      {parsed.scopeLine ? (
        <text fg={cliTheme.text.secondary}>
          {parsed.scopeLine}
        </text>
      ) : null}

      {parsed.metadataLines.map((line) => (
        <text key={line} fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          {line}
        </text>
      ))}

      <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
        Recent messages were preserved
      </text>
    </box>
  );
}

export { isContextSummaryMessage };
