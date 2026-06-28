import { SyntaxStyle } from "@opentui/core";
import { typeRole, borderStyleFor, cliTheme } from "../../ui/cli-theme";

const proposedPlanOpenTag = "<proposed_plan>";
const proposedPlanCloseTag = "</proposed_plan>";
const planMarkdownSyntaxStyle = SyntaxStyle.create();

/**
 * Count markdown sections (headings) and bullet items in plan text.
 * Sections: lines starting with # followed by space (markdown headings)
 * Bullets: unordered list items (- asterisk /+) or ordered list items (1./2./etc.)
 */
export function countPlanContent(text: string): {
  sections: number;
  bullets: number;
} {
  const lines = text.split("\n");
  let sections = 0;
  let bullets = 0;

  for (const line of lines) {
    // Count section headings: lines starting with # followed by space
    if (/^#+\s/.test(line)) {
      sections++;
      continue;
    }

    // Count unordered list items: line starting with -, *, or + followed by space
    if (/^[-*+]\s/.test(line)) {
      bullets++;
      continue;
    }

    // Count ordered list items: line starting with number followed by . and space
    if (/^\d+\.\s/.test(line)) {
      bullets++;
    }
  }

  return { sections, bullets };
}

export type ProposedPlanSegment =
  | { type: "text"; text: string }
  | { type: "plan"; text: string };

/**
 * Extracts the first markdown heading from text.
 * Matches lines starting with 1-6 # characters followed by a space.
 * Returns undefined if no heading is found.
 */
export function extractFirstHeading(text: string): string | undefined {
  const match = text.match(/^(#{1,6})\s+(.+)$/m);
  return match ? match[2].trim() : undefined;
}

export function splitProposedPlanBlocks(text: string): ProposedPlanSegment[] {
  const segments: ProposedPlanSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const openIndex = text.indexOf(proposedPlanOpenTag, cursor);
    if (openIndex === -1) {
      segments.push({ type: "text", text: text.slice(cursor) });
      break;
    }

    const planStart = openIndex + proposedPlanOpenTag.length;
    const closeIndex = text.indexOf(proposedPlanCloseTag, planStart);
    if (closeIndex === -1) {
      segments.push({ type: "text", text: text.slice(cursor) });
      break;
    }

    if (openIndex > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, openIndex) });
    }

    segments.push({
      type: "plan",
      text: text.slice(planStart, closeIndex).trim(),
    });

    cursor = closeIndex + proposedPlanCloseTag.length;
  }

  return segments.length > 0 ? segments : [{ type: "text", text }];
}

export function containsProposedPlanBlock(text: string): boolean {
  return splitProposedPlanBlocks(text).some((segment) => segment.type === "plan");
}

interface ChatProposedPlanCardProps {
  content: string;
}

export function ChatProposedPlanCard({ content }: ChatProposedPlanCardProps) {
  const planContent = content.trim();
  const { sections, bullets } = countPlanContent(planContent);
  const firstHeading = extractFirstHeading(planContent);

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.card}
      borderColor={cliTheme.borders.active}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <box width="100%" flexDirection="column" gap={0}>
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <text {...typeRole("title")}>Proposed plan</text>
          <text {...typeRole("caption")}>{firstHeading ?? "review required"}</text>
        </box>
        <text {...typeRole("caption")}>
          {sections} section{sections !== 1 ? "s" : ""} | {bullets} bullet
          {bullets !== 1 ? "s" : ""}
        </text>
      </box>

      {planContent.length > 0 ? (
        <markdown
          width="100%"
          content={planContent}
          syntaxStyle={planMarkdownSyntaxStyle}
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
      ) : (
        <text {...typeRole("caption")}>
          No plan content provided
        </text>
      )}
    </box>
  );
}