import { parsePartialJson } from "ai";

/**
 * Best-effort repair of tool-call argument JSON emitted by weaker models.
 * Handles truncated output (unclosed braces/strings), single quotes,
 * unquoted keys, trailing commas, and Python literals.
 *
 * Returns the parsed value, or null when nothing plausible can be recovered.
 */
export async function repairToolJson(raw: string): Promise<unknown | null> {
  const text = raw.trim();
  if (!text) return null;

  const direct = tryParse(text);
  if (direct !== undefined) return direct;

  // parsePartialJson closes truncated structures (the common case when the
  // model output was cut off at the token limit).
  const partial = await parsePartialJson(text);
  if (
    (partial.state === "repaired-parse" || partial.state === "successful-parse") &&
    partial.value !== null &&
    typeof partial.value === "object"
  ) {
    return partial.value;
  }

  const healed = healJsonSyntax(text);
  const healedParse = tryParse(healed);
  if (healedParse !== undefined) return healedParse;

  const healedPartial = await parsePartialJson(healed);
  if (
    (healedPartial.state === "repaired-parse" || healedPartial.state === "successful-parse") &&
    healedPartial.value !== null &&
    typeof healedPartial.value === "object"
  ) {
    return healedPartial.value;
  }

  return null;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic syntax healing for common weak-model JSON mistakes.
 * Operates outside of double-quoted strings so legitimate content survives.
 */
export function healJsonSyntax(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        result += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        result += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        result += ch;
        continue;
      }
      // Escape raw newlines inside strings (models often emit them verbatim).
      if (ch === "\n") {
        result += "\\n";
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        continue;
      }
      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    // Single-quoted string -> double-quoted (naive but effective outside strings).
    if (ch === "'") {
      let j = i + 1;
      let body = "";
      while (j < text.length && text[j] !== "'") {
        if (text[j] === "\\" && j + 1 < text.length) {
          body += text[j] + text[j + 1];
          j += 2;
          continue;
        }
        body += text[j];
        j += 1;
      }
      result += `"${body.replace(/"/g, '\\"')}"`;
      i = j;
      continue;
    }

    // Unquoted object key: identifier followed by a colon.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      let word = "";
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) {
        word += text[j];
        j += 1;
      }
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k += 1;

      if (text[k] === ":") {
        result += `"${word}"`;
        i = j - 1;
        continue;
      }

      // Python literals as values.
      if (word === "True") {
        result += "true";
        i = j - 1;
        continue;
      }
      if (word === "False") {
        result += "false";
        i = j - 1;
        continue;
      }
      if (word === "None") {
        result += "null";
        i = j - 1;
        continue;
      }

      result += word;
      i = j - 1;
      continue;
    }

    // Trailing comma before a closing bracket.
    if (ch === ",") {
      let k = i + 1;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      if (text[k] === "}" || text[k] === "]") {
        continue;
      }
    }

    result += ch;
  }

  return result;
}
