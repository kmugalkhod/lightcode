import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import {
  chatInteractionListResponseSchema,
  chatInteractionListQuerySchema,
  chatInteractionResolveRequestSchema,
  chatInteractionSchema,
  chatInteractionUpsertRequestSchema,
  isTerminalChatInteractionStatus,
  sessionIdSchema,
  type ChatInteraction,
  type ChatInteractionKind,
  type ChatInteractionPendingSummary,
  type ChatInteractionResolveRequest,
  type ChatInteractionStatus,
  type ChatInteractionUpsertRequest,
} from "@lightcode/ai";
import {
  filePathFromDatabaseUrl,
  getDefaultDatabasePath,
  initializeLocalDatabase,
  resolveDatabaseUrl,
} from "@lightcode/db/local-database";

export class ChatInteractionNotFoundError extends Error {
  constructor(toolCallId: string) {
    super(`Chat interaction not found: ${toolCallId}`);
    this.name = "ChatInteractionNotFoundError";
  }
}

// Singleton database instance — initialized once and closed on process exit
let _db: Database | null = null;
let _initialized = false;

function getDatabase(): Database {
  if (!_initialized) {
    const dbUrl = resolveDatabaseUrl();
    initializeLocalDatabase(dbUrl);
    _initialized = true;
  }

  if (!_db) {
    const dbUrl = process.env.DATABASE_URL ?? getDefaultDatabasePath();
    const dbPath = filePathFromDatabaseUrl(dbUrl) ?? (dbUrl.startsWith("file:") ? dbUrl.slice(5) : dbUrl);

    _db = new Database(dbPath as string);
  }

  return _db;
}

// Close the database on process exit to avoid connection leaks
process.on("exit", () => {
  _db?.close();
  _db = null;
});

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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

function safeStringifyJson(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (isJsonValue(v)) return v;
    return "[unserializable]";
  });
}

interface ChatInteractionRow {
  id: string;
  session_id: string;
  tool_call_id: string;
  kind: string;
  status: string;
  payload: string;
  response: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

function toChatInteraction(row: ChatInteractionRow): ChatInteraction {
  return chatInteractionSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    kind: row.kind,
    status: row.status,
    payload: JSON.parse(row.payload),
    response: row.response ? JSON.parse(row.response) : null,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function findChatInteraction({
  sessionId,
  toolCallId,
}: {
  sessionId: string;
  toolCallId: string;
}): Promise<ChatInteractionRow | null> {
  const db = getDatabase();
  const row = db
    .query<ChatInteractionRow, [string, string]>(
      `SELECT * FROM chat_interactions 
       WHERE session_id = ? AND tool_call_id = ? 
       LIMIT 1`
    )
    .get(sessionId, toolCallId);
  return row ?? null;
}

export async function upsertChatInteraction({
  sessionId,
  ...rawInput
}: {
  sessionId: string;
} & ChatInteractionUpsertRequest): Promise<ChatInteraction> {
  const validatedSessionId = sessionIdSchema.parse(sessionId);
  const input = chatInteractionUpsertRequestSchema.parse(rawInput);

  const db = getDatabase();
  const existing = await findChatInteraction({
    sessionId: validatedSessionId,
    toolCallId: input.toolCallId,
  });

  if (existing && isTerminalChatInteractionStatus(existing.status as ChatInteractionStatus)) {
    return toChatInteraction(existing);
  }

  const now = new Date().toISOString();
  const payload = safeStringifyJson(input.payload);

  if (existing) {
    db.query(
      `UPDATE chat_interactions 
       SET kind = ?, status = ?, payload = ?, response = NULL, 
           resolved_at = NULL, updated_at = ? 
       WHERE id = ?`
    ).run(input.kind, "pending", payload, now, existing.id);

    const updated = db
      .query<ChatInteractionRow, [string]>("SELECT * FROM chat_interactions WHERE id = ?")
      .get(existing.id);
    return toChatInteraction(updated!);
  }

  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO chat_interactions 
       (id, session_id, tool_call_id, kind, status, payload, response, resolved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`
  ).run(id, validatedSessionId, input.toolCallId, input.kind, payload, now, now);

  const inserted = db
    .query<ChatInteractionRow, [string]>("SELECT * FROM chat_interactions WHERE id = ?")
    .get(id);
  return toChatInteraction(inserted!);
}

export async function resolveChatInteraction({
  sessionId,
  toolCallId,
  ...rawInput
}: {
  sessionId: string;
  toolCallId: string;
} & ChatInteractionResolveRequest): Promise<ChatInteraction> {
  const validatedSessionId = sessionIdSchema.parse(sessionId);
  const input = chatInteractionResolveRequestSchema.parse(rawInput);

  const db = getDatabase();
  const existing = await findChatInteraction({
    sessionId: validatedSessionId,
    toolCallId,
  });

  if (!existing) {
    throw new ChatInteractionNotFoundError(toolCallId);
  }

  if (isTerminalChatInteractionStatus(existing.status as ChatInteractionStatus)) {
    return toChatInteraction(existing);
  }

  const now = new Date().toISOString();
  const response = input.response !== undefined ? safeStringifyJson(input.response) : null;

  db.query(
    `UPDATE chat_interactions 
     SET status = ?, response = ?, resolved_at = ?, updated_at = ? 
     WHERE id = ?`
  ).run(input.status, response, now, now, existing.id);

  const updated = db
    .query<ChatInteractionRow, [string]>("SELECT * FROM chat_interactions WHERE id = ?")
    .get(existing.id);
  return toChatInteraction(updated!);
}

export async function listChatInteractions({
  sessionId,
  status,
  kind,
}: {
  sessionId: string;
  status?: ChatInteractionStatus;
  kind?: ChatInteractionKind;
}) {
  const query = chatInteractionListQuerySchema.parse({ status, kind });
  const db = getDatabase();

  let sql = `SELECT * FROM chat_interactions WHERE session_id = ?`;
  const params: string[] = [sessionIdSchema.parse(sessionId)];

  if (query.status) {
    sql += ` AND status = ?`;
    params.push(query.status);
  }

  if (query.kind) {
    sql += ` AND kind = ?`;
    params.push(query.kind);
  }

  sql += ` ORDER BY created_at ASC`;

  const rows = db
    .query<ChatInteractionRow, string[]>(sql)
    .all(...params);

  return chatInteractionListResponseSchema.parse({
    interactions: rows.map(toChatInteraction),
  });
}

export async function summarizePendingChatInteractions({
  staleAfterMs = 30 * 60 * 1000,
}: {
  staleAfterMs?: number;
} = {}): Promise<ChatInteractionPendingSummary> {
  const db = getDatabase();
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();

  const toolApprovals = db
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) as count FROM chat_interactions 
       WHERE status = ? AND kind = ?`
    )
    .get("pending", "tool_approval")!.count;

  const userPrompts = db
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) as count FROM chat_interactions 
       WHERE status = ? AND kind = ?`
    )
    .get("pending", "user_prompt")!.count;

  const stale = db
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) as count FROM chat_interactions 
       WHERE status = ? AND updated_at < ?`
    )
    .get("pending", staleBefore)!.count;

  const total = toolApprovals + userPrompts;

  return {
    total,
    toolApprovals,
    userPrompts,
    stale,
    recoverable: total,
  };
}
