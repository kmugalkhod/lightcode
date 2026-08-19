import type { MessageRole, Prisma } from "@lightcode/db/types";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  codingAgentModeSchema,
  defaultCodingAgentMode,
  permissionModeSchema,
  type CodingAgentMode,
  type PermissionMode,
  type SessionExportJson,
  type SessionMetadata,
  type SessionSummary,
  type SessionTurnRequest,
} from "@lightcode/ai";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { incrementChatFailureCounter } from "./chat-observability";
import { storeInlineMessageBlobs } from "./attachment-store";
import { prisma } from "./prisma-client";

const roleByUiMessageRole = {
  assistant: "assistant",
  system: "system",
  user: "user",
} satisfies Record<UIMessage["role"], MessageRole>;

export class SessionNotFoundError extends Error {
  constructor(sessionIdentifier: string) {
    super(`Session not found: ${sessionIdentifier}`);
    this.name = "SessionNotFoundError";
  }
}

export type SessionWorkspaceIdentityErrorCode =
  | "workspace_unavailable"
  | "workspace_replaced"
  | "workspace_identity_unavailable";

export class SessionWorkspaceIdentityError extends Error {
  constructor(
    readonly code: SessionWorkspaceIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionWorkspaceIdentityError";
  }
}

export interface SessionWorkspaceIdentity {
  cwd: string;
  device: string;
  inode: string;
  initializedLegacy: boolean;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface ChatSessionMetadataRecord {
  id: string;
  title: string | null;
  cwd: string | null;
  mode: string;
  permissionMode: string | null;
  model: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

function isPrismaInputJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry));
  }

  if (isRecord(value)) {
    return Object.values(value).every((entry) => isJsonValue(entry));
  }

  return false;
}

function getErrorCode(error: unknown): string | number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.parse(JSON.stringify(value));

  if (!isPrismaInputJsonValue(serialized)) {
    throw new Error("Unable to serialize message payload to JSON.");
  }

  return serialized;
}

function toMessageId(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeMessageForStorage(message: UIMessage, sequence: number): UIMessage {
  const normalizedId = toMessageId(message.id, `message-${sequence}`);

  return {
    ...message,
    id: normalizedId,
  };
}

function normalizeSessionTitle(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();

  if (normalized.length <= 80) {
    return normalized;
  }

  return `${normalized.slice(0, 77).trimEnd()}...`;
}

function normalizeSessionPreview(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();

  if (normalized.length <= 120) {
    return normalized;
  }

  return `${normalized.slice(0, 117).trimEnd()}...`;
}

function isTextMessagePart(
  part: UIMessage["parts"][number],
): part is Extract<UIMessage["parts"][number], { type: "text"; text: string }> {
  return part.type === "text" && "text" in part && typeof part.text === "string";
}

function extractTextFromMessage(message: UIMessage): string {
  const textParts = message.parts
    .filter(isTextMessagePart)
    .map((part) => part.text)
    .filter((text) => text.length > 0);

  if (textParts.length > 0) {
    return textParts.join(" ");
  }

  return "";
}

function deriveSessionTitle(messages: UIMessage[]): string | null {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return null;
  }

  const text = extractTextFromMessage(firstUserMessage).trim();
  if (!text) {
    return null;
  }

  return normalizeSessionTitle(text);
}

function coerceSessionMode(value: string | null | undefined): CodingAgentMode {
  const parsed = codingAgentModeSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultCodingAgentMode;
}

function coercePermissionMode(
  value: string | null | undefined,
): PermissionMode | null {
  const parsed = permissionModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toSessionMetadata(session: ChatSessionMetadataRecord): SessionMetadata {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    mode: coerceSessionMode(session.mode),
    permissionMode: coercePermissionMode(session.permissionMode),
    model: session.model,
    revision: session.revision,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function extractUserPromptPreviewFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const candidate = {
    id: "preview-message",
    role: "user",
    parts: Array.isArray(payload.parts) ? payload.parts : [],
  } satisfies Pick<UIMessage, "id" | "role" | "parts">;
  const text = extractTextFromMessage(candidate as UIMessage).trim();

  return text ? normalizeSessionPreview(text) : null;
}

function toStoredMessage(
  sessionId: string,
  sequence: number,
  message: UIMessage,
  assistantModel: string | null
) {
  const normalizedMessage = normalizeMessageForStorage(message, sequence);
  const persistedMessageId = `${sequence}:${normalizedMessage.id}`;

  return {
    id: crypto.randomUUID(),
    sessionId,
    messageId: persistedMessageId,
    role: roleByUiMessageRole[normalizedMessage.role],
    sequence,
    model: normalizedMessage.role === "assistant" ? assistantModel : null,
    payload: toPrismaJsonValue(normalizedMessage),
  } satisfies Prisma.ChatMessageUncheckedCreateInput;
}

function toStoredMessageParts(
  storedMessages: readonly Prisma.ChatMessageUncheckedCreateInput[],
  messages: readonly UIMessage[],
  startIndex = 0,
): Prisma.ChatMessagePartUncheckedCreateInput[] {
  return storedMessages.slice(startIndex).flatMap((storedMessage, offset) => {
    const message = messages[startIndex + offset];
    if (!message || typeof storedMessage.id !== "string") {
      return [];
    }

    return message.parts.map((part, partIndex) => ({
      id: crypto.randomUUID(),
      messageId: storedMessage.id as string,
      partIndex,
      payload: toPrismaJsonValue(part),
    }));
  });
}

async function normalizeAndValidateMessages(messages: UIMessage[]): Promise<UIMessage[]> {
  const normalizedMessages = messages.map((message, index) =>
    normalizeMessageForStorage(message, index)
  );
  const validationResult = await safeValidateUIMessages({
    messages: normalizedMessages,
  });

  if (!validationResult.success) {
    throw new Error(`Invalid chat messages payload: ${validationResult.error.message}`);
  }

  return validationResult.data;
}

function isPrismaUniqueConstraintError(error: unknown) {
  return getErrorCode(error) === "P2002";
}

function isPrismaTransactionStartTimeoutError(error: unknown) {
  return getErrorCode(error) === "P2028";
}

interface CanonicalWorkspaceIdentity {
  cwd: string;
  device: string;
  inode: string;
}

function toPortableWorkspaceIdentity(
  metadata: { dev: bigint; ino: bigint },
): Pick<CanonicalWorkspaceIdentity, "device" | "inode"> {
  // Node does not expose a stable directory file id on every Windows
  // filesystem. Canonical/no-symlink checks still apply there; Unix persists
  // the native device+inode pair so a same-path replacement is detected.
  if (metadata.ino === 0n) {
    return { device: "unsupported", inode: "unsupported" };
  }
  return {
    device: metadata.dev.toString(10),
    inode: metadata.ino.toString(10),
  };
}

async function readCanonicalWorkspaceIdentity(
  cwd: string,
  { requireAlreadyCanonical = false }: { requireAlreadyCanonical?: boolean } = {},
): Promise<CanonicalWorkspaceIdentity> {
  const resolved = path.resolve(cwd);
  try {
    const lexicalMetadata = await lstat(resolved, { bigint: true });
    if (lexicalMetadata.isSymbolicLink()) {
      throw new SessionWorkspaceIdentityError(
        "workspace_replaced",
        "The saved workspace root is now a symbolic link. Select the workspace again.",
      );
    }
    if (!lexicalMetadata.isDirectory()) {
      throw new SessionWorkspaceIdentityError(
        "workspace_unavailable",
        "The saved workspace root is not a directory.",
      );
    }

    const canonical = await realpath(resolved);
    if (requireAlreadyCanonical && canonical !== resolved) {
      throw new SessionWorkspaceIdentityError(
        "workspace_identity_unavailable",
        "This legacy workspace path is not canonical. Select the workspace again before running tools.",
      );
    }
    const canonicalMetadata = await lstat(canonical, { bigint: true });
    if (
      canonicalMetadata.isSymbolicLink() ||
      !canonicalMetadata.isDirectory()
    ) {
      throw new SessionWorkspaceIdentityError(
        "workspace_unavailable",
        "The saved workspace root is not a real directory.",
      );
    }

    return {
      cwd: canonical,
      ...toPortableWorkspaceIdentity(canonicalMetadata),
    };
  } catch (error) {
    if (error instanceof SessionWorkspaceIdentityError) {
      throw error;
    }
    const code = getErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new SessionWorkspaceIdentityError(
        "workspace_unavailable",
        "Lightcode no longer has permission to access this workspace.",
      );
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SessionWorkspaceIdentityError(
        "workspace_unavailable",
        "The saved workspace no longer exists.",
      );
    }
    throw error;
  }
}

function workspaceIdentitiesMatch(
  stored: { workspaceDevice: string; workspaceInode: string },
  current: CanonicalWorkspaceIdentity,
): boolean {
  if (
    stored.workspaceDevice === "unsupported" &&
    stored.workspaceInode === "unsupported"
  ) {
    return current.device === "unsupported" && current.inode === "unsupported";
  }
  return (
    stored.workspaceDevice === current.device &&
    stored.workspaceInode === current.inode
  );
}

/**
 * Revalidates the server-authoritative workspace immediately before a run can
 * read files or execute tools. Legacy rows initialize only when their saved
 * root is already canonical and is a real directory—not a replacement link.
 */
export async function assertSessionWorkspaceIdentity(
  sessionId: string,
): Promise<SessionWorkspaceIdentity> {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      cwd: true,
      workspaceDevice: true,
      workspaceInode: true,
    },
  });
  if (!session) {
    throw new SessionNotFoundError(sessionId);
  }
  if (!session.cwd) {
    throw new SessionWorkspaceIdentityError(
      "workspace_unavailable",
      "Session has no canonical workspace directory.",
    );
  }

  const current = await readCanonicalWorkspaceIdentity(session.cwd, {
    requireAlreadyCanonical: true,
  });
  const hasDevice = session.workspaceDevice !== null;
  const hasInode = session.workspaceInode !== null;
  if (hasDevice !== hasInode) {
    throw new SessionWorkspaceIdentityError(
      "workspace_identity_unavailable",
      "The saved workspace identity is incomplete. Select the workspace again.",
    );
  }

  if (!hasDevice || !hasInode) {
    // Re-check after the first read, then initialize with an optimistic null
    // predicate so concurrent legacy resumes cannot overwrite one another.
    const confirmed = await readCanonicalWorkspaceIdentity(session.cwd, {
      requireAlreadyCanonical: true,
    });
    if (
      confirmed.cwd !== current.cwd ||
      confirmed.device !== current.device ||
      confirmed.inode !== current.inode
    ) {
      throw new SessionWorkspaceIdentityError(
        "workspace_replaced",
        "The workspace changed while its identity was being verified.",
      );
    }
    const initialized = await prisma.chatSession.updateMany({
      where: {
        id: session.id,
        cwd: session.cwd,
        workspaceDevice: null,
        workspaceInode: null,
      },
      data: {
        workspaceDevice: confirmed.device,
        workspaceInode: confirmed.inode,
      },
    });
    if (initialized.count === 0) {
      return assertSessionWorkspaceIdentity(sessionId);
    }
    return { ...confirmed, initializedLegacy: true };
  }

  if (session.workspaceDevice === null || session.workspaceInode === null) {
    throw new SessionWorkspaceIdentityError(
      "workspace_identity_unavailable",
      "The saved workspace identity is incomplete. Select the workspace again.",
    );
  }

  if (
    !workspaceIdentitiesMatch(
      {
        workspaceDevice: session.workspaceDevice,
        workspaceInode: session.workspaceInode,
      },
      current,
    )
  ) {
    throw new SessionWorkspaceIdentityError(
      "workspace_replaced",
      "The workspace was replaced on disk. Select it again before running tools.",
    );
  }

  return { ...current, initializedLegacy: false };
}

export async function createChatSession({
  cwd = process.cwd(),
  mode = defaultCodingAgentMode,
  permissionMode = null,
  model = null,
  title,
  expectedWorkspaceIdentity,
}: {
  cwd?: string;
  mode?: CodingAgentMode;
  permissionMode?: PermissionMode | null;
  model?: string | null;
  title?: string;
  expectedWorkspaceIdentity?: { device: string; inode: string };
} = {}): Promise<{ id: string }> {
  const workspace = await readCanonicalWorkspaceIdentity(cwd);
  if (
    expectedWorkspaceIdentity &&
    (workspace.device !== expectedWorkspaceIdentity.device ||
      workspace.inode !== expectedWorkspaceIdentity.inode)
  ) {
    throw new SessionWorkspaceIdentityError(
      "workspace_replaced",
      "The workspace changed before the session could be created. Select it again.",
    );
  }
  const createdSession = await prisma.chatSession.create({
    data: {
      id: crypto.randomUUID(),
      cwd: workspace.cwd,
      workspaceDevice: workspace.device,
      workspaceInode: workspace.inode,
      mode,
      permissionMode,
      model,
      title: title ? normalizeSessionTitle(title) : null,
    },
    select: { id: true },
  });

  return { id: createdSession.id };
}

export interface PersistChatMessagesResult {
  revision: number;
  staleSkip: boolean;
}

/**
 * Last-persisted message hashes per session, so a persist call that only
 * appends (the common case: every chat turn re-sends the full history) writes
 * just the divergent tail instead of delete-and-rewriting O(history) rows.
 * The revision optimistic lock guards correctness: any write this cache did
 * not observe changes the revision, which forces a full rewrite. Entries are
 * dropped on stale skips, errors, and session deletion.
 */
const persistedMessageHashCache = new Map<
  string,
  { revision: number; hashes: string[] }
>();

export function clearPersistedMessageHashCache(): void {
  persistedMessageHashCache.clear();
}

function hashStoredMessage(
  stored: Prisma.ChatMessageUncheckedCreateInput,
): string {
  // The payload embeds the message id and role; model is the only other
  // column that can change for an identical payload.
  return String(Bun.hash(`${stored.model ?? ""}|${JSON.stringify(stored.payload)}`));
}

export async function persistChatMessages({
  sessionId,
  messages,
  assistantModel = null,
  expectedRevision,
  cwd,
  mode,
  permissionMode,
}: {
  sessionId: string;
  messages: UIMessage[];
  assistantModel?: string | null;
  expectedRevision?: number;
  cwd?: string;
  mode?: CodingAgentMode;
  permissionMode?: PermissionMode | null;
}): Promise<PersistChatMessagesResult> {
  const existingSession = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  const workspace = existingSession
    ? await assertSessionWorkspaceIdentity(sessionId)
    : await readCanonicalWorkspaceIdentity(cwd ?? process.cwd());
  const normalizedMessages = await normalizeAndValidateMessages(messages);
  const sessionTitle = deriveSessionTitle(normalizedMessages);
  const storedMessages = normalizedMessages.map((message, sequence) =>
    toStoredMessage(sessionId, sequence, message, assistantModel)
  );
  const messageHashes = storedMessages.map(hashStoredMessage);

  const maxTransactionAttempts = 3;

  for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const session = await tx.chatSession.upsert({
            where: { id: sessionId },
            update: {},
            create: {
              id: sessionId,
              title: sessionTitle,
              cwd: workspace.cwd,
              workspaceDevice: workspace.device,
              workspaceInode: workspace.inode,
              mode: mode ?? defaultCodingAgentMode,
              permissionMode: permissionMode ?? null,
              model: assistantModel,
            },
            select: {
              id: true,
              title: true,
              revision: true,
            },
          });

          if (expectedRevision !== undefined && session.revision !== expectedRevision) {
            persistedMessageHashCache.delete(sessionId);
            return {
              revision: session.revision,
              staleSkip: true,
            };
          }

          // Incremental write: when this process persisted the current
          // revision, only the tail past the longest unchanged prefix needs
          // touching. Any revision this cache did not observe (other writer,
          // restart) falls back to the full delete + rewrite.
          const cached = persistedMessageHashCache.get(sessionId);
          const canWriteIncrementally =
            cached !== undefined && cached.revision === session.revision;

          if (canWriteIncrementally) {
            let firstDivergent = 0;
            const comparable = Math.min(
              cached.hashes.length,
              messageHashes.length,
            );
            while (
              firstDivergent < comparable &&
              cached.hashes[firstDivergent] === messageHashes[firstDivergent]
            ) {
              firstDivergent += 1;
            }

            if (firstDivergent < cached.hashes.length) {
              await tx.chatMessage.deleteMany({
                where: { sessionId, sequence: { gte: firstDivergent } },
              });
            }
            const tail = storedMessages.slice(firstDivergent);
            if (tail.length > 0) {
              await tx.chatMessage.createMany({
                data: tail,
              });
              const tailParts = toStoredMessageParts(
                storedMessages,
                normalizedMessages,
                firstDivergent,
              );
              if (tailParts.length > 0) {
                await tx.chatMessagePart.createMany({ data: tailParts });
              }
            }
          } else {
            await tx.chatMessage.deleteMany({
              where: { sessionId },
            });

            if (storedMessages.length > 0) {
              await tx.chatMessage.createMany({
                data: storedMessages,
              });
              const parts = toStoredMessageParts(
                storedMessages,
                normalizedMessages,
              );
              if (parts.length > 0) {
                await tx.chatMessagePart.createMany({ data: parts });
              }
            }
          }

          const updatedSession = await tx.chatSession.update({
            where: { id: sessionId },
            data: {
              revision: {
                increment: 1,
              },
              ...(mode
                ? {
                    mode,
                  }
                : {}),
              ...(permissionMode !== undefined
                ? {
                    permissionMode,
                  }
                : {}),
              ...(assistantModel
                ? {
                    model: assistantModel,
                  }
                : {}),
              ...(sessionTitle && !session.title
                ? {
                    title: sessionTitle,
                  }
                : {}),
            },
            select: {
              revision: true,
            },
          });

          persistedMessageHashCache.set(sessionId, {
            revision: updatedSession.revision,
            hashes: messageHashes,
          });

          return {
            revision: updatedSession.revision,
            staleSkip: false,
          };
        },
        {
          maxWait: 10_000,
          timeout: 20_000,
        }
      );
    } catch (error) {
      // The transaction may have died anywhere; never trust the cache after.
      persistedMessageHashCache.delete(sessionId);

      if (isPrismaUniqueConstraintError(error)) {
        incrementChatFailureCounter("db_unique_conflict", {
          sessionId,
        });
      }

      if (
        isPrismaTransactionStartTimeoutError(error) &&
        attempt < maxTransactionAttempts
      ) {
        await Bun.sleep(50 * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unreachable");
}

function hydratePersistedMessages(
  persistedMessages: Array<{
    sequence: number;
    role: MessageRole;
    payload: unknown;
  }>,
) {
  const normalizedCandidates = persistedMessages.map((persistedMessage) => {
    const payload =
      persistedMessage.payload && typeof persistedMessage.payload === "object" && !Array.isArray(persistedMessage.payload)
        ? persistedMessage.payload
        : {};
    const payloadRecord = isRecord(payload) ? payload : {};

    return {
      ...payloadRecord,
      id: toMessageId(
        typeof payloadRecord.id === "string" ? payloadRecord.id : undefined,
        `message-${persistedMessage.sequence}`
      ),
      role:
        typeof payloadRecord.role === "string"
          ? payloadRecord.role
          : persistedMessage.role,
    };
  });

  return normalizedCandidates;
}

async function validatePersistedMessages(
  persistedMessages: Array<{
    sequence: number;
    role: MessageRole;
    payload: unknown;
  }>,
) {
  if (persistedMessages.length === 0) {
    return [];
  }

  const validationResult = await safeValidateUIMessages({
    messages: hydratePersistedMessages(persistedMessages),
  });

  if (!validationResult.success) {
    console.error(`Persisted chat history failed validation, starting fresh: ${validationResult.error.message}`);
    return [];
  }

  return validationResult.data;
}

export async function resolveChatSessionIdentifier(sessionIdentifier: string) {
  if (sessionIdentifier !== "latest") {
    return sessionIdentifier;
  }

  const latestSession = await prisma.chatSession.findFirst({
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });

  if (!latestSession) {
    throw new SessionNotFoundError(sessionIdentifier);
  }

  return latestSession.id;
}

export async function loadChatSessionWithMessages(sessionIdentifier: string): Promise<{
  session: SessionMetadata;
  messages: UIMessage[];
}> {
  const sessionId = await resolveChatSessionIdentifier(sessionIdentifier);
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      title: true,
      cwd: true,
      mode: true,
      permissionMode: true,
      model: true,
      revision: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: { sequence: "asc" },
        select: {
          sequence: true,
          role: true,
          payload: true,
        },
      },
    },
  });

  if (!session) {
    throw new SessionNotFoundError(sessionIdentifier);
  }

  const { messages, ...sessionMetadata } = session;

  return {
    session: toSessionMetadata(sessionMetadata),
    messages: await validatePersistedMessages(messages),
  };
}

export async function loadChatMessages(sessionIdentifier: string): Promise<UIMessage[]> {
  return (await loadChatSessionWithMessages(sessionIdentifier)).messages;
}

/**
 * Merges a single client delta onto canonical server history. A delta may
 * append a new user message, or replace only the current tail message (approval
 * responses and sanitized retries update the trailing assistant/user message).
 * Earlier history can never be rewritten by the client.
 */
export async function mergeSessionTurnDelta(
  sessionIdentifier: string,
  input: SessionTurnRequest,
): Promise<{
  session: SessionMetadata;
  messages: UIMessage[];
  appended: boolean;
}> {
  const loaded = await loadChatSessionWithMessages(sessionIdentifier);
  const candidate = {
    id: input.messageId,
    role: input.role,
    parts: input.parts,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
  const validation = await safeValidateUIMessages({ messages: [candidate] });
  if (!validation.success || validation.data.length !== 1) {
    throw new Error(
      `Invalid turn message: ${validation.success ? "empty message" : validation.error.message}`,
    );
  }

  const [incoming] = await storeInlineMessageBlobs(validation.data);
  if (!incoming) {
    throw new Error("Invalid turn message: empty message.");
  }
  const existingIndex = loaded.messages.findIndex(
    (message) => message.id === incoming.id,
  );
  if (existingIndex >= 0) {
    if (existingIndex !== loaded.messages.length - 1) {
      throw new Error("A turn delta may only replace the latest message.");
    }
    if (loaded.messages[existingIndex].role !== incoming.role) {
      throw new Error("A turn delta cannot change an existing message role.");
    }
    return {
      session: loaded.session,
      messages: [...loaded.messages.slice(0, -1), incoming],
      appended: false,
    };
  }

  if (incoming.role !== "user") {
    throw new Error("Only a user message may be appended to canonical history.");
  }

  return {
    session: loaded.session,
    messages: [...loaded.messages, incoming],
    appended: true,
  };
}

export async function listChatSessions(limit = 50): Promise<SessionSummary[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const sessions = await prisma.chatSession.findMany({
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: safeLimit,
    select: {
      id: true,
      title: true,
      cwd: true,
      mode: true,
      permissionMode: true,
      model: true,
      revision: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          messages: true,
        },
      },
      messages: {
        where: { role: "user" },
        orderBy: { sequence: "desc" },
        take: 1,
        select: {
          payload: true,
        },
      },
    },
  });

  return sessions.map((session) => {
    const { _count, messages, ...metadata } = session;
    const latestUserPromptPreview =
      messages[0] ? extractUserPromptPreviewFromPayload(messages[0].payload) : null;

    return {
      ...toSessionMetadata(metadata),
      messageCount: _count.messages,
      latestUserPromptPreview,
    };
  });
}

/** User-initiated rename: pins the title so auto-titling never overwrites it. */
export async function renameChatSession(sessionId: string, title: string) {
  const normalizedTitle = normalizeSessionTitle(title);

  try {
    const session = await prisma.chatSession.update({
      where: { id: sessionId },
      data: { title: normalizedTitle, autoTitled: true },
      select: { id: true, title: true },
    });
    return { id: session.id, title: session.title };
  } catch (error) {
    if (getErrorCode(error) === "P2025") {
      throw new SessionNotFoundError(sessionId);
    }
    throw error;
  }
}

/** Updates session metadata: title and/or permission mode. */
export async function updateSessionMetadata(
  sessionId: string,
  updates: { title?: string; permissionMode?: PermissionMode },
) {
  try {
    const data: Prisma.ChatSessionUpdateInput = {};

    if (updates.title !== undefined) {
      data.title = normalizeSessionTitle(updates.title);
      data.autoTitled = true;
    }

    if (updates.permissionMode !== undefined) {
      data.permissionMode = updates.permissionMode;
    }

    const session = await prisma.chatSession.update({
      where: { id: sessionId },
      data,
      select: { id: true, title: true, permissionMode: true },
    });

    return {
      id: session.id,
      title: session.title,
      permissionMode: session.permissionMode,
    };
  } catch (error) {
    if (getErrorCode(error) === "P2025") {
      throw new SessionNotFoundError(sessionId);
    }
    throw error;
  }
}

/** Applies an LLM-generated title unless one was already pinned. */
export async function applyGeneratedSessionTitle(sessionId: string, title: string) {
  const normalizedTitle = normalizeSessionTitle(title);

  const updated = await prisma.chatSession.updateMany({
    where: { id: sessionId, autoTitled: false },
    data: { title: normalizedTitle, autoTitled: true },
  });

  return updated.count > 0;
}

/** Duplicates a session with its messages; interactions and context state regenerate. */
export async function forkChatSession(sessionId: string): Promise<{
  id: string;
  copiedMessages: number;
}> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        title: true,
        cwd: true,
        workspaceDevice: true,
        workspaceInode: true,
        mode: true,
        permissionMode: true,
        model: true,
        messages: {
          orderBy: { sequence: "asc" },
          select: {
            messageId: true,
            role: true,
            model: true,
            sequence: true,
            payload: true,
          },
        },
      },
    });

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    const forkId = crypto.randomUUID();
    const { messages, ...metadata } = session;

    await tx.chatSession.create({
      data: {
        id: forkId,
        ...metadata,
        title: metadata.title ? `${metadata.title} (fork)` : null,
        autoTitled: true,
        revision: 0,
      },
    });

    if (messages.length > 0) {
      const forkMessages = messages.map((message) => ({
        ...message,
        id: crypto.randomUUID(),
        payload: toPrismaJsonValue(message.payload),
        sessionId: forkId,
      }));
      await tx.chatMessage.createMany({
        data: forkMessages,
      });
      const hydratedMessages = await validatePersistedMessages(
        messages.map((message) => ({
          sequence: message.sequence,
          role: message.role,
          payload: message.payload,
        })),
      );
      const forkParts = toStoredMessageParts(
        forkMessages,
        hydratedMessages,
      );
      if (forkParts.length > 0) {
        await tx.chatMessagePart.createMany({ data: forkParts });
      }
    }

    return { id: forkId, copiedMessages: messages.length };
  });
}

export async function deleteChatSession(sessionId: string) {
  persistedMessageHashCache.delete(sessionId);
  return prisma.$transaction(async (tx) => {
    const existingSession = await tx.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });

    if (!existingSession) {
      throw new SessionNotFoundError(sessionId);
    }

    await tx.chatSession.delete({
      where: { id: sessionId },
    });

    return {
      id: existingSession.id,
      deleted: true,
      deletedMessages: existingSession._count.messages,
    };
  });
}

export async function exportChatSessionJson(
  sessionIdentifier: string,
): Promise<SessionExportJson> {
  const sessionWithMessages = await loadChatSessionWithMessages(sessionIdentifier);
  const messages = JSON.parse(
    JSON.stringify(sessionWithMessages.messages),
  ) as SessionExportJson["messages"];

  return {
    exportedAt: new Date().toISOString(),
    session: sessionWithMessages.session,
    messages,
  };
}
