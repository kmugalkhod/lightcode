export interface CodeBlock {
  lang?: string;
  code: string;
}

// Fenced blocks: ```lang\n ... \n``` . The info string excludes backticks and
// newlines; the body is captured non-greedily so the first closing fence ends it.
const FENCE_RE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;

/** Extracts fenced code blocks from markdown text (empty blocks are skipped). */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  FENCE_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const lang = match[1]?.trim();
    const code = (match[2] ?? "").replace(/\r?\n$/, "");
    if (code.trim()) {
      blocks.push({ lang: lang ? lang : undefined, code });
    }
  }

  return blocks;
}

/**
 * The code worth copying from a message: the fenced blocks joined together, or
 * the whole text when the message has no code fences.
 */
export function collectCopyableCode(text: string): string {
  const blocks = extractCodeBlocks(text);
  if (blocks.length === 0) {
    return text.trim();
  }
  return blocks.map((block) => block.code).join("\n\n");
}
