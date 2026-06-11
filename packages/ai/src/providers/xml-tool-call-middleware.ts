import { generateId, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import {
  confirmToolCallMarker,
  extractToolCalls,
  findToolBlockEnd,
  findToolCallMarkerMatch,
  looksLikeTruncatedToolCall,
  markerHoldbackLength,
  mayContainTextToolCall,
  type ParsedTextToolCall,
  type ToolCallMarker,
} from "./xml-tool-call-parser";

/**
 * Handles models (e.g. MiniMax, DeepSeek via OpenRouter) that output tool
 * calls as text instead of proper API-level function invocations.
 *
 * Streaming is incremental and non-latching: plain text flows through
 * immediately. A tool-call marker only pauses the stream provisionally —
 * the buffer must CONFIRM the dialect within a small window, markers inside
 * markdown code fences are ignored, and a completed block is parsed and
 * emitted as proper tool-call parts right away with streaming resuming
 * after it. Prose that merely mentions a marker is flushed verbatim, never
 * stripped.
 *
 * Genuinely truncated tool calls (stream ends mid-block) are repaired when
 * possible; otherwise they are stripped and flagged via
 * providerMetadata.lightcode.toolIntent = "unparsed" so the client nudges
 * the model instead of going idle.
 */

const TOOL_CALLS_FINISH_REASON: LanguageModelV3FinishReason = {
  unified: "tool-calls",
  raw: "tool_calls",
};

const FALLBACK_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: undefined, reasoning: undefined },
};

type FinishPart = Extract<LanguageModelV3StreamPart, { type: "finish" }>;

function knownToolNames(params: LanguageModelV3CallOptions): string[] {
  return (params.tools ?? [])
    .map((tool) => ("name" in tool ? tool.name : null))
    .filter((name): name is string => typeof name === "string");
}

function buildFinishPart(
  original: FinishPart | null,
  hasToolCalls: boolean,
  hadUnparsedIntent: boolean,
): FinishPart {
  const base: FinishPart = {
    type: "finish",
    usage: original?.usage ?? FALLBACK_USAGE,
    finishReason: hasToolCalls
      ? TOOL_CALLS_FINISH_REASON
      : (original?.finishReason ?? { unified: "stop", raw: "stop" }),
    ...(original?.providerMetadata ? { providerMetadata: original.providerMetadata } : {}),
  };

  if (hadUnparsedIntent && !hasToolCalls) {
    base.providerMetadata = {
      ...base.providerMetadata,
      lightcode: {
        ...(base.providerMetadata?.lightcode ?? {}),
        toolIntent: "unparsed",
      },
    };
  }

  return base;
}

function toolCallParts(call: ParsedTextToolCall): LanguageModelV3StreamPart[] {
  return [
    { type: "tool-input-start", id: call.toolCallId, toolName: call.toolName },
    { type: "tool-input-delta", id: call.toolCallId, delta: call.input },
    { type: "tool-input-end", id: call.toolCallId },
    {
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    },
  ];
}

function countFences(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

export const xmlToolCallMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",

  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    const toolNames = knownToolNames(params);
    const upstream = result.stream.getReader();

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        // Text not yet emitted: a short holdback tail, or — while a marker is
        // being confirmed / a block is being completed — the candidate block.
        let pending = "";
        let mode: "text" | "tool" = "text";
        let activeMarker: ToolCallMarker | null = null;
        // ``` parity of everything emitted so far; markers inside fenced code
        // blocks are prose, not tool calls.
        let emittedFenceCount = 0;
        let textOpen = false;
        let textId = "";
        let finishPart: FinishPart | null = null;
        let sawNativeToolCall = false;
        let anyParsedCalls = false;
        let unparsedIntent = false;

        const emitText = (delta: string) => {
          if (!delta) return;
          if (!textOpen) {
            textId = generateId();
            controller.enqueue({ type: "text-start", id: textId });
            textOpen = true;
          }
          controller.enqueue({ type: "text-delta", id: textId, delta });
          emittedFenceCount += countFences(delta);
        };

        const closeText = () => {
          if (textOpen) {
            controller.enqueue({ type: "text-end", id: textId });
            textOpen = false;
          }
        };

        const emitParsedCalls = (calls: readonly ParsedTextToolCall[]) => {
          closeText();
          for (const call of calls) {
            for (const part of toolCallParts(call)) controller.enqueue(part);
          }
          anyParsedCalls = true;
        };

        const processPending = async (atStreamEnd: boolean) => {
          for (;;) {
            if (mode === "text") {
              // Find the earliest marker that is outside a code fence.
              let searchFrom = 0;
              let found: ReturnType<typeof findToolCallMarkerMatch> = null;
              for (;;) {
                const match = findToolCallMarkerMatch(pending, searchFrom);
                if (!match) break;
                const fenceParity =
                  (emittedFenceCount + countFences(pending.slice(0, match.index))) % 2;
                if (fenceParity === 1) {
                  searchFrom = match.index + match.marker.length;
                  continue;
                }
                found = match;
                break;
              }

              if (!found) {
                const holdback = atStreamEnd ? 0 : markerHoldbackLength(pending);
                if (pending.length > holdback) {
                  emitText(pending.slice(0, pending.length - holdback));
                  pending = pending.slice(pending.length - holdback);
                }
                return;
              }

              if (found.index > 0) {
                emitText(pending.slice(0, found.index));
                pending = pending.slice(found.index);
              }
              mode = "tool";
              activeMarker = found.marker;
              continue;
            }

            // mode === "tool": pending starts at the marker.
            const marker = activeMarker!;
            const confirmation = confirmToolCallMarker(pending, marker);

            if (confirmation === "rejected") {
              // Prose that merely mentioned a marker: flush the literal
              // marker text and rescan what follows it.
              emitText(pending.slice(0, marker.length));
              pending = pending.slice(marker.length);
              mode = "text";
              activeMarker = null;
              continue;
            }

            if (confirmation === "pending" && !atStreamEnd) {
              return; // need more deltas to decide
            }

            const blockEnd = findToolBlockEnd(pending, marker);

            if (blockEnd === -1) {
              if (!atStreamEnd) {
                return; // genuine block still streaming in
              }
              // Stream ended mid-block: repair if it really is a truncated
              // call, otherwise flush verbatim.
              const extraction = await extractToolCalls(pending, toolNames);
              if (extraction.calls.length > 0) {
                emitText(extraction.cleanText);
                emitParsedCalls(extraction.calls);
              } else if (looksLikeTruncatedToolCall(pending)) {
                unparsedIntent = true;
                emitText(extraction.cleanText);
              } else {
                emitText(pending);
              }
              pending = "";
              return;
            }

            // A closed block: parse it now and resume streaming after it.
            const block = pending.slice(0, blockEnd);
            pending = pending.slice(blockEnd);
            const extraction = await extractToolCalls(block, toolNames);
            if (extraction.calls.length > 0) {
              emitText(extraction.cleanText);
              emitParsedCalls(extraction.calls);
            } else if (extraction.hadUnparsedIntent) {
              unparsedIntent = true;
              emitText(extraction.cleanText);
            } else {
              emitText(block);
            }
            mode = "text";
            activeMarker = null;
          }
        };

        try {
          for (;;) {
            const { done, value } = await upstream.read();
            if (done) break;

            switch (value.type) {
              case "text-start":
              case "text-end":
                // Replaced by our own consolidated text blocks.
                break;
              case "text-delta":
                pending += value.delta;
                await processPending(false);
                break;
              case "finish":
                finishPart = value;
                break;
              case "tool-call":
                sawNativeToolCall = true;
                closeText();
                controller.enqueue(value);
                break;
              default:
                controller.enqueue(value);
                break;
            }
          }
        } catch (error) {
          closeText();
          controller.error(error);
          return;
        } finally {
          upstream.releaseLock();
        }

        await processPending(true);
        closeText();

        controller.enqueue(
          buildFinishPart(
            finishPart,
            anyParsedCalls || sawNativeToolCall,
            unparsedIntent && !anyParsedCalls,
          ),
        );
        controller.close();
      },
    });

    return { ...result, stream };
  },

  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    const toolNames = knownToolNames(params);

    const textParts = result.content.filter(
      (p): p is Extract<typeof p, { type: "text" }> => p.type === "text",
    );
    const fullText = textParts.map((p) => p.text).join("");

    if (!mayContainTextToolCall(fullText)) {
      return result;
    }

    const { calls, cleanText, hadUnparsedIntent } = await extractToolCalls(
      fullText,
      toolNames,
    );

    if (calls.length === 0 && !hadUnparsedIntent) {
      return result;
    }

    const nonTextContent = result.content.filter((p) => p.type !== "text");
    const newContent = [
      ...nonTextContent,
      ...(cleanText ? [{ type: "text" as const, text: cleanText }] : []),
      ...calls.map((call) => ({
        type: "tool-call" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      })),
    ];

    return {
      ...result,
      content: newContent,
      finishReason: calls.length > 0 ? TOOL_CALLS_FINISH_REASON : result.finishReason,
      ...(hadUnparsedIntent && calls.length === 0
        ? {
            providerMetadata: {
              ...result.providerMetadata,
              lightcode: {
                ...(result.providerMetadata?.lightcode ?? {}),
                toolIntent: "unparsed",
              },
            },
          }
        : {}),
    };
  },
};

/**
 * Wraps a language model with the XML tool-call middleware.
 * Transparent for models that emit proper function calls — plain text streams
 * through incrementally with only a few characters of lookahead held back.
 */
export function withXmlToolCallSupport(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({ model, middleware: xmlToolCallMiddleware });
}
