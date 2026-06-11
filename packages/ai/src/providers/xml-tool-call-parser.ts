import { generateId } from "ai";
import { repairToolJson } from "./tool-call-json-repair";

/**
 * Shared parsing for models that emit tool calls as text instead of proper
 * API-level function invocations. Supported dialects:
 *
 *  1. <tool_call>{"name":"x","arguments":{...}}</tool_call> (also <function_call>)
 *  2. <invoke name="x"><parameter name="a">v</parameter></invoke>
 *  3. <function=x>{...}</function> (or <parameter=a>v lines)
 *  4. DeepSeek markers: <｜tool▁call▁begin｜>function<｜tool▁sep｜>x\n{json}<｜tool▁call▁end｜>
 *  5. Bare trailing JSON {"name": "x", "arguments": {...}} matching a known tool
 *
 * Truncated/unclosed blocks and malformed JSON are repaired when possible;
 * unrepairable blocks are stripped (never leaked as text) and flagged so the
 * caller can trigger a continuation nudge.
 */

export interface ParsedTextToolCall {
  toolCallId: string;
  toolName: string;
  /** JSON-encoded arguments. */
  input: string;
}

export interface ExtractToolCallsResult {
  calls: ParsedTextToolCall[];
  cleanText: string;
  /** True when tool intent was detected but could not be parsed or repaired. */
  hadUnparsedIntent: boolean;
}

/**
 * Open markers that may begin a textual tool call. Used by the streaming
 * state machine to decide how much text can be safely emitted downstream.
 */
export const TOOL_CALL_OPEN_MARKERS = [
  "<tool_call>",
  "<function_call>",
  "<invoke",
  "<function=",
  "<｜tool▁calls▁begin｜>",
  "<｜tool▁call▁begin｜>",
] as const;
export type ToolCallMarker = (typeof TOOL_CALL_OPEN_MARKERS)[number];

export interface ToolCallMarkerMatch {
  index: number;
  marker: ToolCallMarker;
}

const MAX_MARKER_LENGTH = Math.max(
  ...TOOL_CALL_OPEN_MARKERS.map((m) => m.length),
);

/** Earliest full open marker in `text` at or after `fromIndex`, or null. */
export function findToolCallMarkerMatch(
  text: string,
  fromIndex = 0,
): ToolCallMarkerMatch | null {
  const lower = text.toLowerCase();
  let earliest: ToolCallMarkerMatch | null = null;
  for (const marker of TOOL_CALL_OPEN_MARKERS) {
    const idx = lower.indexOf(marker.toLowerCase(), fromIndex);
    if (idx !== -1 && (earliest === null || idx < earliest.index)) {
      earliest = { index: idx, marker };
    }
  }
  return earliest;
}

/** Index of the earliest full open marker in `text`, or -1. */
export function findToolCallMarker(text: string): number {
  return findToolCallMarkerMatch(text)?.index ?? -1;
}

/**
 * How many characters past the open marker the streaming state machine will
 * buffer while deciding whether the marker is a real tool call. Beyond this,
 * an unconfirmed marker is treated as ordinary prose.
 */
export const MARKER_CONFIRMATION_WINDOW = 256;

export type MarkerConfirmation = "confirmed" | "rejected" | "pending";

/**
 * Decides whether `buffer` (which starts exactly at an open marker) looks
 * like a genuine tool-call block of that dialect. "pending" means more data
 * is needed; callers should reject once the confirmation window is exceeded.
 */
export function confirmToolCallMarker(
  buffer: string,
  marker: ToolCallMarker,
): MarkerConfirmation {
  if (buffer.length > marker.length + MARKER_CONFIRMATION_WINDOW) {
    const eager = confirmWithinWindow(buffer, marker);
    return eager === "pending" ? "rejected" : eager;
  }
  return confirmWithinWindow(buffer, marker);
}

function confirmWithinWindow(
  buffer: string,
  marker: ToolCallMarker,
): MarkerConfirmation {
  switch (marker) {
    case "<tool_call>":
    case "<function_call>": {
      // Genuine calls follow the tag with a JSON object (optionally fenced).
      const body = buffer.slice(marker.length);
      const trimmed = body.replace(/^\s*/, "");
      if (trimmed.length === 0) {
        return body.length > 64 ? "rejected" : "pending";
      }
      return trimmed[0] === "{" || trimmed[0] === "`" ? "confirmed" : "rejected";
    }
    case "<invoke": {
      const rest = buffer.slice(marker.length);
      if (rest.length === 0) return "pending";
      const wsMatch = /^(\s*)/.exec(rest);
      const ws = wsMatch?.[1].length ?? 0;
      if (ws === 0) return "rejected"; // e.g. "<invoked", "<invoke>"
      const after = rest.slice(ws);
      if (after.length === 0) return "pending";
      const target = "name=";
      if (after.length < target.length) {
        return target.startsWith(after) ? "pending" : "rejected";
      }
      return after.startsWith(target) ? "confirmed" : "rejected";
    }
    case "<function=": {
      const rest = buffer.slice(marker.length);
      if (/^[\w.-]+>/.test(rest)) return "confirmed";
      return /^[\w.-]*$/.test(rest) && rest.length < 64 ? "pending" : "rejected";
    }
    case "<｜tool▁calls▁begin｜>":
    case "<｜tool▁call▁begin｜>":
      return "confirmed";
  }
}

const BLOCK_CLOSE_MARKERS: Record<ToolCallMarker, string[]> = {
  "<tool_call>": ["</tool_call>"],
  "<function_call>": ["</function_call>"],
  "<invoke": ["</invoke>"],
  "<function=": ["</function>"],
  "<｜tool▁calls▁begin｜>": ["<｜tool▁calls▁end｜>"],
  "<｜tool▁call▁begin｜>": ["<｜tool▁call▁end｜>"],
};

/**
 * End index (exclusive) of the closed tool block that starts at offset 0 of
 * `buffer` with the given marker, or -1 when the close marker has not
 * arrived yet.
 */
export function findToolBlockEnd(buffer: string, marker: ToolCallMarker): number {
  const lower = buffer.toLowerCase();
  for (const close of BLOCK_CLOSE_MARKERS[marker]) {
    const idx = lower.indexOf(close.toLowerCase(), marker.length);
    if (idx !== -1) {
      return idx + close.length;
    }
  }
  return -1;
}

/**
 * Cheap pre-filter for non-streaming paths: text may contain a textual tool
 * call either via an XML-style marker or a bare JSON tool payload.
 */
export function mayContainTextToolCall(text: string): boolean {
  return findToolCallMarker(text) !== -1 || /\{\s*"name"\s*:/.test(text);
}

/**
 * Whether an unclosed block at stream end plausibly IS a truncated tool call
 * (vs. prose that merely mentioned a marker). Only plausible blocks are
 * stripped and flagged; everything else is flushed verbatim.
 */
export function looksLikeTruncatedToolCall(block: string): boolean {
  const trimmed = block.trim();
  return (
    /"name"\s*:/.test(trimmed) ||
    /<parameter[\s=]/i.test(trimmed) ||
    /<｜tool▁sep｜>/.test(trimmed) ||
    /^<(?:tool_call|function_call)>\s*(?:\{|```|$)/i.test(trimmed) ||
    /^<invoke\s+name=/i.test(trimmed) ||
    /^<function=[\w.-]+>/i.test(trimmed) ||
    /^<｜tool▁calls?▁begin｜>/.test(trimmed)
  );
}

/**
 * Length of the longest suffix of `text` that is a proper prefix of any open
 * marker — i.e. how many trailing characters must be held back because they
 * might turn into a marker once more deltas arrive.
 */
export function markerHoldbackLength(text: string): number {
  const lower = text.toLowerCase();
  const maxCheck = Math.min(MAX_MARKER_LENGTH - 1, lower.length);
  for (let len = maxCheck; len > 0; len--) {
    const suffix = lower.slice(lower.length - len);
    for (const marker of TOOL_CALL_OPEN_MARKERS) {
      if (marker.toLowerCase().startsWith(suffix)) {
        return len;
      }
    }
  }
  return 0;
}

const CLOSED_BLOCK_RES = {
  jsonTag: /<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi,
  invoke: /<invoke\s+name=["']?([\w.-]+)["']?\s*>([\s\S]*?)<\/invoke>/gi,
  functionEq: /<function=([\w.-]+)>([\s\S]*?)<\/function>/gi,
  deepseek:
    /<｜tool▁call▁begin｜>\s*(?:function)?\s*(?:<｜tool▁sep｜>)?\s*([\w.-]+)\s*\n?([\s\S]*?)<｜tool▁call▁end｜>/g,
} as const;

const DEEPSEEK_WRAPPER_RE = /<｜tool▁calls▁(?:begin|end)｜>/g;

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function readToolPayload(value: unknown): { name: string; args: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const name =
    typeof p.name === "string" ? p.name
    : typeof p.function_name === "string" ? p.function_name
    : typeof p.tool === "string" ? p.tool
    : typeof p.function === "string" ? p.function
    : null;
  if (!name) return null;
  const args = p.parameters ?? p.arguments ?? p.input ?? p.args ?? {};
  return { name, args };
}

async function parseJsonBody(body: string): Promise<{ name: string; args: unknown } | null> {
  const parsed = await repairToolJson(stripCodeFence(body));
  return readToolPayload(parsed);
}

const PARAMETER_TAG_RE = /<parameter\s+name=["']?([\w.-]+)["']?\s*>([\s\S]*?)(?:<\/parameter>|(?=<parameter\s)|$)/gi;
const PARAMETER_EQ_RE = /<parameter=([\w.-]+)>([\s\S]*?)(?=<parameter=|<\/function>|$)/gi;

function coerceParameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed !== "" && !Number.isNaN(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // fall through to string
    }
  }
  return trimmed;
}

function parseParameterBody(body: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  let found = false;
  for (const re of [PARAMETER_TAG_RE, PARAMETER_EQ_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      args[match[1]] = coerceParameterValue(match[2]);
      found = true;
    }
    if (found) break;
  }
  return found ? args : null;
}

async function parseInvokeBody(
  name: string,
  body: string,
): Promise<{ name: string; args: unknown }> {
  const paramArgs = parseParameterBody(body);
  if (paramArgs) return { name, args: paramArgs };
  const trimmed = stripCodeFence(body);
  if (trimmed) {
    const parsed = await repairToolJson(trimmed);
    if (parsed && typeof parsed === "object") return { name, args: parsed };
  }
  return { name, args: {} };
}

interface Segment {
  start: number;
  end: number;
  call: ParsedTextToolCall | null;
}

/**
 * Extracts textual tool calls from `text`. `knownToolNames` (when provided)
 * gates the bare-JSON dialect only — XML-style dialects always emit so that
 * agent-level name repair can fix near-miss tool names.
 */
export async function extractToolCalls(
  text: string,
  knownToolNames?: readonly string[],
): Promise<ExtractToolCallsResult> {
  const segments: Segment[] = [];
  let hadUnparsedIntent = false;

  const pushCall = (start: number, end: number, payload: { name: string; args: unknown } | null) => {
    if (payload) {
      segments.push({
        start,
        end,
        call: {
          toolCallId: generateId(),
          toolName: payload.name,
          input: JSON.stringify(payload.args ?? {}),
        },
      });
    } else {
      hadUnparsedIntent = true;
      segments.push({ start, end, call: null });
    }
  };

  // Closed JSON-body tags.
  CLOSED_BLOCK_RES.jsonTag.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOSED_BLOCK_RES.jsonTag.exec(text)) !== null) {
    pushCall(match.index, match.index + match[0].length, await parseJsonBody(match[1]));
  }

  // Closed <invoke name="x"> blocks.
  CLOSED_BLOCK_RES.invoke.lastIndex = 0;
  while ((match = CLOSED_BLOCK_RES.invoke.exec(text)) !== null) {
    pushCall(
      match.index,
      match.index + match[0].length,
      await parseInvokeBody(match[1], match[2]),
    );
  }

  // Closed <function=x> blocks.
  CLOSED_BLOCK_RES.functionEq.lastIndex = 0;
  while ((match = CLOSED_BLOCK_RES.functionEq.exec(text)) !== null) {
    pushCall(
      match.index,
      match.index + match[0].length,
      await parseInvokeBody(match[1], match[2]),
    );
  }

  // Closed DeepSeek blocks.
  CLOSED_BLOCK_RES.deepseek.lastIndex = 0;
  while ((match = CLOSED_BLOCK_RES.deepseek.exec(text)) !== null) {
    const body = stripCodeFence(match[2]);
    const parsed = body ? await repairToolJson(body) : {};
    pushCall(
      match.index,
      match.index + match[0].length,
      parsed && typeof parsed === "object" ? { name: match[1], args: parsed } : null,
    );
  }

  // DeepSeek wrapper markers are noise either way.
  DEEPSEEK_WRAPPER_RE.lastIndex = 0;
  while ((match = DEEPSEEK_WRAPPER_RE.exec(text)) !== null) {
    segments.push({ start: match.index, end: match.index + match[0].length, call: null });
  }

  // Unclosed/truncated block: an open marker not covered by any closed segment.
  const covered = (idx: number) => segments.some((s) => idx >= s.start && idx < s.end);
  const orphanIdx = findOrphanMarker(text, covered);
  if (orphanIdx !== -1) {
    const orphan = text.slice(orphanIdx);
    const salvaged = await salvageOrphanBlock(orphan);
    pushCall(orphanIdx, text.length, salvaged);
  }

  // Bare trailing JSON tool call (gated on known tool names to avoid
  // misreading ordinary JSON in prose).
  if (segments.length === 0 && knownToolNames?.length) {
    const bare = await parseBareTrailingJson(text, knownToolNames);
    if (bare) {
      pushCall(bare.start, text.length, bare.payload);
    }
  }

  segments.sort((a, b) => a.start - b.start);

  let cleanText = "";
  let cursor = 0;
  const calls: ParsedTextToolCall[] = [];
  for (const segment of segments) {
    if (segment.start > cursor) {
      cleanText += text.slice(cursor, segment.start);
    }
    cursor = Math.max(cursor, segment.end);
    if (segment.call) calls.push(segment.call);
  }
  cleanText += text.slice(cursor);

  // A successfully parsed call means the loop continues; stale intent flag
  // would only cause a redundant nudge.
  if (calls.length > 0) {
    hadUnparsedIntent = false;
  }

  return { calls, cleanText: cleanText.trim(), hadUnparsedIntent };
}

function findOrphanMarker(
  text: string,
  covered: (idx: number) => boolean,
): number {
  const lower = text.toLowerCase();
  const xmlMarkers = TOOL_CALL_OPEN_MARKERS.filter((m) => m.startsWith("<"));
  let earliest = -1;
  for (const marker of xmlMarkers) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(marker.toLowerCase(), from);
      if (idx === -1) break;
      if (!covered(idx)) {
        if (earliest === -1 || idx < earliest) earliest = idx;
        break;
      }
      from = idx + marker.length;
    }
  }
  return earliest;
}

async function salvageOrphanBlock(
  orphan: string,
): Promise<{ name: string; args: unknown } | null> {
  const lower = orphan.toLowerCase();

  if (lower.startsWith("<tool_call>") || lower.startsWith("<function_call>")) {
    const body = orphan.slice(orphan.indexOf(">") + 1);
    return parseJsonBody(body);
  }

  const invokeMatch = /^<invoke\s+name=["']?([\w.-]+)["']?\s*>?([\s\S]*)$/i.exec(orphan);
  if (invokeMatch) {
    return parseInvokeBody(invokeMatch[1], invokeMatch[2]);
  }

  const functionEqMatch = /^<function=([\w.-]+)>?([\s\S]*)$/i.exec(orphan);
  if (functionEqMatch) {
    return parseInvokeBody(functionEqMatch[1], functionEqMatch[2]);
  }

  const deepseekMatch =
    /^(?:<｜tool▁calls▁begin｜>\s*)?<｜tool▁call▁begin｜>\s*(?:function)?\s*(?:<｜tool▁sep｜>)?\s*([\w.-]+)\s*\n?([\s\S]*)$/.exec(
      orphan,
    );
  if (deepseekMatch) {
    const body = stripCodeFence(deepseekMatch[2]);
    const parsed = body ? await repairToolJson(body) : {};
    return parsed && typeof parsed === "object"
      ? { name: deepseekMatch[1], args: parsed }
      : null;
  }

  // Bare wrapper marker with no call inside — noise, nothing to salvage,
  // and nothing to nudge about either.
  if (/^<｜tool▁calls▁begin｜>\s*$/.test(orphan.trim())) {
    return null;
  }

  return null;
}

async function parseBareTrailingJson(
  text: string,
  knownToolNames: readonly string[],
): Promise<{ start: number; payload: { name: string; args: unknown } } | null> {
  const idx = text.lastIndexOf('{"name"');
  if (idx === -1) return null;
  // Only treat as a tool call when it runs to the end of the message.
  const candidate = text.slice(idx);
  const parsed = await repairToolJson(candidate);
  const payload = readToolPayload(parsed);
  if (!payload || !knownToolNames.includes(payload.name)) return null;
  return { start: idx, payload };
}
