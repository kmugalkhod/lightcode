import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { getLightcodeDataDir } from "@lightcode/shared";
import {
  toolModelMessageSchema,
  type ModelMessage,
  type ToolResultPart,
} from "ai";
import { DEFAULT_TOOL_TEXT_OUTPUT_CHARS } from "../constants";

export const TOOL_OUTPUT_ARTIFACT_HANDLE_PREFIX =
  "lightcode-artifact://tool-output/sha256/";

/** Tool results above this serialized size are stored outside provider history. */
export const DEFAULT_TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARACTERS =
  DEFAULT_TOOL_TEXT_OUTPUT_CHARS;

/** Provider history keeps a compact head/tail view of an artifact. */
export const DEFAULT_TOOL_OUTPUT_ARTIFACT_PREVIEW_CHARACTERS = 2_400;

const MIN_TOOL_OUTPUT_ARTIFACT_PREVIEW_CHARACTERS = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_PREVIEW_MARKER = "[Lightcode tool-output artifact]";

type ToolResultOutput = ToolResultPart["output"];

export interface ToolOutputArtifactReference {
  kind: "tool-output";
  algorithm: "sha256";
  digest: string;
  handle: string;
  byteSize: number;
  characterSize: number;
  originalOutputType: ToolResultOutput["type"];
}

export interface ArtifactizeToolOutputsOptions {
  /** Lightcode's per-user data directory. Defaults to getLightcodeDataDir(). */
  dataDir?: string;
  /** Store an output when its canonical JSON is larger than this many chars. */
  thresholdCharacters?: number;
  /** Hard character ceiling for the text placed in provider history. */
  previewCharacters?: number;
  signal?: AbortSignal;
}

export interface ArtifactizedModelMessages {
  /** Ephemeral provider view. Never persist this in place of canonical history. */
  messages: ModelMessage[];
  /** Unique artifacts referenced by the returned provider view. */
  artifacts: ToolOutputArtifactReference[];
  /** Number of tool-result occurrences replaced (duplicates count separately). */
  artifactizedOutputs: number;
  savedCharacters: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalizes JSON objects recursively so semantically identical key ordering
 * produces the same content address. ToolResultOutput is JSON-serializable by
 * the AI SDK contract; unsupported/circular values fail instead of being lost.
 */
function canonicalizeJson(
  value: unknown,
  ancestors: Set<object>,
  inArray: boolean,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return inArray ? null : undefined;
  }

  if (typeof value === "bigint") {
    throw new TypeError("Tool output artifacts cannot serialize bigint values.");
  }

  if (!isRecord(value)) {
    return value;
  }

  if (ancestors.has(value)) {
    throw new TypeError("Tool output artifacts cannot serialize circular values.");
  }

  ancestors.add(value);
  try {
    const toJSON = Reflect.get(value, "toJSON");
    if (typeof toJSON === "function") {
      return canonicalizeJson(toJSON.call(value), ancestors, inArray);
    }

    if (Array.isArray(value)) {
      return value.map((entry) => canonicalizeJson(entry, ancestors, true));
    }

    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = canonicalizeJson(value[key], ancestors, false);
      if (entry !== undefined) {
        normalized[key] = entry;
      }
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function serializeToolResultOutput(output: ToolResultOutput): string {
  const serialized = JSON.stringify(
    canonicalizeJson(output, new Set<object>(), false),
  );
  if (serialized === undefined) {
    throw new TypeError("Tool output artifact serialization returned no data.");
  }
  return serialized;
}

function digestText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function digestFromHandleOrDigest(handleOrDigest: string): string {
  const digest = handleOrDigest.startsWith(TOOL_OUTPUT_ARTIFACT_HANDLE_PREFIX)
    ? handleOrDigest.slice(TOOL_OUTPUT_ARTIFACT_HANDLE_PREFIX.length)
    : handleOrDigest;
  if (!SHA256_PATTERN.test(digest)) {
    throw new TypeError(
      `Invalid Lightcode tool-output artifact: ${handleOrDigest}`,
    );
  }
  return digest;
}

export function getToolOutputArtifactPath(
  handleOrDigest: string,
  dataDir = getLightcodeDataDir(),
): string {
  const digest = digestFromHandleOrDigest(handleOrDigest);
  return path.join(
    dataDir,
    "artifacts",
    "tool-outputs",
    "sha256",
    digest.slice(0, 2),
    `${digest}.json`,
  );
}

function artifactReference(
  output: ToolResultOutput,
  serialized: string,
): ToolOutputArtifactReference {
  const digest = digestText(serialized);
  return {
    kind: "tool-output",
    algorithm: "sha256",
    digest,
    handle: `${TOOL_OUTPUT_ARTIFACT_HANDLE_PREFIX}${digest}`,
    byteSize: Buffer.byteLength(serialized, "utf8"),
    characterSize: serialized.length,
    originalOutputType: output.type,
  };
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

async function verifyExistingArtifact(
  filePath: string,
  expected: string,
  signal?: AbortSignal,
): Promise<void> {
  const existing = await fs.readFile(filePath, { encoding: "utf8", signal });
  if (existing !== expected || digestText(existing) !== digestText(expected)) {
    throw new Error(
      `Tool-output artifact collision or corruption at ${filePath}.`,
    );
  }
}

/**
 * Persists bytes through a temporary file and an exclusive hard link. The
 * final content-addressed path therefore appears atomically, and concurrent or
 * repeated writers converge without rewriting the artifact.
 */
async function persistArtifact(
  reference: ToolOutputArtifactReference,
  serialized: string,
  dataDir: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const filePath = getToolOutputArtifactPath(reference.digest, dataDir);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = path.join(
    directory,
    `.${reference.digest}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      signal,
    });
    signal?.throwIfAborted();

    try {
      await fs.link(temporaryPath, filePath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      await verifyExistingArtifact(filePath, serialized, signal);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function outputPreviewSource(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(canonicalizeJson(output.value, new Set(), false));
    case "execution-denied":
      return output.reason ?? "Tool execution was denied.";
    case "content":
      return JSON.stringify(canonicalizeJson(output.value, new Set(), false));
  }
}

function buildBoundedPreview(
  reference: ToolOutputArtifactReference,
  source: string,
  maxCharacters: number,
): string {
  const header =
    `${ARTIFACT_PREVIEW_MARKER}\n` +
    `handle: ${reference.handle}\n` +
    `sha256: ${reference.digest}\n` +
    `original-output-type: ${reference.originalOutputType}\n` +
    `stored-json-bytes: ${reference.byteSize}\n` +
    `stored-json-characters: ${reference.characterSize}\n` +
    "preview:\n";

  if (header.length + source.length <= maxCharacters) {
    return `${header}${source}`;
  }

  let marker = "\n\n... [middle omitted from provider preview] ...\n\n";
  let usable = Math.max(0, maxCharacters - header.length - marker.length);
  let headCharacters = Math.floor(usable * 0.7);
  let tailCharacters = usable - headCharacters;
  let omitted = source.length - headCharacters - tailCharacters;
  marker = `\n\n... [${omitted} characters omitted from provider preview] ...\n\n`;
  usable = Math.max(0, maxCharacters - header.length - marker.length);
  headCharacters = Math.floor(usable * 0.7);
  tailCharacters = usable - headCharacters;
  omitted = source.length - headCharacters - tailCharacters;
  marker = `\n\n... [${omitted} characters omitted from provider preview] ...\n\n`;

  // A digit-boundary change in `omitted` can grow the marker by one. Absorb
  // that byte from the tail so the configured ceiling remains a hard limit.
  const overflow = Math.max(
    0,
    header.length +
      headCharacters +
      marker.length +
      tailCharacters -
      maxCharacters,
  );
  tailCharacters = Math.max(0, tailCharacters - overflow);

  const head = source.slice(0, headCharacters);
  const tail = tailCharacters > 0 ? source.slice(-tailCharacters) : "";
  return `${header}${head}${marker}${tail}`;
}

function isArtifactPreview(output: unknown): boolean {
  return (
    isRecord(output) &&
    output.type === "text" &&
    typeof output.value === "string" &&
    output.value.startsWith(`${ARTIFACT_PREVIEW_MARKER}\nhandle: `)
  );
}

/**
 * Stores complete large tool-result outputs and returns a provider-only copy
 * with bounded previews. Input messages and their nested output values are
 * never mutated, so canonical persistence and UI rendering keep full results.
 *
 * Call this immediately before ProviderTurnAssembler.assembleModelMessages()
 * for the initial provider request and for every prepareStep request.
 */
export async function artifactizeLargeToolOutputs(
  messages: readonly ModelMessage[],
  options: ArtifactizeToolOutputsOptions = {},
): Promise<ArtifactizedModelMessages> {
  const dataDir = options.dataDir ?? getLightcodeDataDir();
  const thresholdCharacters = Math.max(
    0,
    Math.floor(
      options.thresholdCharacters ??
        DEFAULT_TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARACTERS,
    ),
  );
  const previewCharacters = Math.floor(
    options.previewCharacters ??
      DEFAULT_TOOL_OUTPUT_ARTIFACT_PREVIEW_CHARACTERS,
  );
  if (previewCharacters < MIN_TOOL_OUTPUT_ARTIFACT_PREVIEW_CHARACTERS) {
    throw new RangeError(
      `Tool-output artifact previews must allow at least ${MIN_TOOL_OUTPUT_ARTIFACT_PREVIEW_CHARACTERS} characters.`,
    );
  }

  const uniqueArtifacts = new Map<string, ToolOutputArtifactReference>();
  let artifactizedOutputs = 0;
  let savedCharacters = 0;
  const providerMessages: ModelMessage[] = [];

  for (const message of messages) {
    options.signal?.throwIfAborted();
    if (!Array.isArray(message.content)) {
      providerMessages.push(message);
      continue;
    }

    let changed = false;
    const providerContent: unknown[] = [];
    for (const part of message.content as unknown[]) {
      if (
        !isRecord(part) ||
        part.type !== "tool-result" ||
        !("output" in part) ||
        isArtifactPreview(part.output)
      ) {
        providerContent.push(part);
        continue;
      }

      const output = part.output as ToolResultOutput;
      const serialized = serializeToolResultOutput(output);
      if (serialized.length <= thresholdCharacters) {
        providerContent.push(part);
        continue;
      }

      const reference = artifactReference(output, serialized);
      if (!uniqueArtifacts.has(reference.digest)) {
        await persistArtifact(
          reference,
          serialized,
          dataDir,
          options.signal,
        );
        uniqueArtifacts.set(reference.digest, reference);
      }

      const preview = buildBoundedPreview(
        reference,
        outputPreviewSource(output),
        previewCharacters,
      );
      const providerOptions = isRecord(output)
        ? Reflect.get(output, "providerOptions")
        : undefined;
      providerContent.push({
        ...part,
        output: {
          type: "text",
          value: preview,
          ...(providerOptions !== undefined
            ? { providerOptions }
            : {}),
        },
      });
      artifactizedOutputs += 1;
      savedCharacters += Math.max(0, serialized.length - preview.length);
      changed = true;
    }

    providerMessages.push(
      changed
        ? ({ ...message, content: providerContent } as ModelMessage)
        : message,
    );
  }

  return {
    messages: providerMessages,
    artifacts: [...uniqueArtifacts.values()],
    artifactizedOutputs,
    savedCharacters,
  };
}

/** Reads and integrity-checks a complete artifact through its opaque handle. */
export async function readToolOutputArtifact(
  handleOrDigest: string,
  {
    dataDir = getLightcodeDataDir(),
    signal,
  }: { dataDir?: string; signal?: AbortSignal } = {},
): Promise<ToolResultOutput> {
  const digest = digestFromHandleOrDigest(handleOrDigest);
  const filePath = getToolOutputArtifactPath(digest, dataDir);
  const serialized = await fs.readFile(filePath, {
    encoding: "utf8",
    signal,
  });
  if (digestText(serialized) !== digest) {
    throw new Error(
      `Tool-output artifact failed integrity verification: ${digest}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Tool-output artifact is not valid JSON: ${digest}`, {
      cause: error,
    });
  }

  const parsed = toolModelMessageSchema.safeParse({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "artifact",
        toolName: "artifact",
        output: value,
      },
    ],
  });
  if (!parsed.success) {
    throw new Error(`Tool-output artifact has an invalid payload: ${digest}`);
  }
  const part = parsed.data.content[0];
  if (part.type !== "tool-result") {
    throw new Error(`Tool-output artifact has an invalid payload: ${digest}`);
  }
  return part.output;
}

/** Useful for diagnostics and garbage collectors without opening the artifact. */
export async function toolOutputArtifactExists(
  handleOrDigest: string,
  dataDir = getLightcodeDataDir(),
): Promise<boolean> {
  try {
    await fs.access(
      getToolOutputArtifactPath(handleOrDigest, dataDir),
      fsConstants.R_OK,
    );
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}
