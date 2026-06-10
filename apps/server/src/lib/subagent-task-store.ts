import { Prisma } from "@lightcode/db/types";
import {
  codingAgentToolNameSchema,
  defaultSubagentTaskMode,
  sessionIdSchema,
  subagentTaskCreateRequestSchema,
  subagentTaskSchema,
  subagentTaskStatusSchema,
  type CodingAgentMode,
  type CodingAgentToolName,
  type SubagentTask,
  type SubagentTaskOutput,
  type SubagentTaskStatus,
} from "@lightcode/ai";
import { prisma } from "./prisma-client";

const terminalSubagentTaskStatuses = new Set<SubagentTaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const subagentTaskSelect = {
  id: true,
  parentSessionId: true,
  prompt: true,
  status: true,
  mode: true,
  model: true,
  allowedTools: true,
  output: true,
  error: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SubagentTaskSelect;

type SubagentTaskRecord = Prisma.SubagentTaskGetPayload<{
  select: typeof subagentTaskSelect;
}>;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class SubagentTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Subagent task not found: ${taskId}`);
    this.name = "SubagentTaskNotFoundError";
  }
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

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.parse(JSON.stringify(value));

  if (!isPrismaInputJsonValue(serialized)) {
    throw new Error("Unable to serialize subagent output to JSON.");
  }

  return serialized;
}

function toPrismaNullableJsonValue(value: unknown) {
  if (value === null) {
    return Prisma.JsonNull;
  }

  return toPrismaJsonValue(value);
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeAllowedTools(
  allowedTools: readonly CodingAgentToolName[],
): CodingAgentToolName[] {
  return [...new Set(allowedTools)];
}

function parseAllowedTools(value: unknown): CodingAgentToolName[] {
  const parsed = codingAgentToolNameSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function toSubagentTask(task: SubagentTaskRecord): SubagentTask {
  return subagentTaskSchema.parse({
    id: task.id,
    parentSessionId: task.parentSessionId,
    prompt: task.prompt,
    status: task.status,
    mode: task.mode,
    model: task.model,
    allowedTools: parseAllowedTools(task.allowedTools),
    output: task.output ?? null,
    error: task.error,
    startedAt: toIsoString(task.startedAt),
    finishedAt: toIsoString(task.finishedAt),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  });
}

function getErrorCode(error: unknown): string | number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function isPrismaRecordNotFoundError(error: unknown) {
  return getErrorCode(error) === "P2025";
}

export async function createSubagentTask({
  parentSessionId,
  prompt,
  status = "pending",
  mode = defaultSubagentTaskMode,
  model = null,
  allowedTools = [],
}: {
  parentSessionId: string;
  prompt: string;
  status?: SubagentTaskStatus;
  mode?: CodingAgentMode;
  model?: string | null;
  allowedTools?: readonly CodingAgentToolName[];
}): Promise<SubagentTask> {
  const validatedTask = subagentTaskCreateRequestSchema.parse({
    parentSessionId,
    prompt,
    mode,
    model,
    allowedTools: normalizeAllowedTools(allowedTools),
  });
  const validatedStatus = subagentTaskStatusSchema.parse(status);

  const task = await prisma.subagentTask.create({
    data: {
      id: crypto.randomUUID(),
      parentSessionId: validatedTask.parentSessionId,
      prompt: validatedTask.prompt,
      status: validatedStatus,
      mode: validatedTask.mode,
      model: validatedTask.model ?? null,
      allowedTools: toPrismaJsonValue(validatedTask.allowedTools),
    },
    select: subagentTaskSelect,
  });

  return toSubagentTask(task);
}

export async function loadSubagentTask(taskId: string): Promise<SubagentTask> {
  const task = await prisma.subagentTask.findUnique({
    where: { id: taskId },
    select: subagentTaskSelect,
  });

  if (!task) {
    throw new SubagentTaskNotFoundError(taskId);
  }

  return toSubagentTask(task);
}

export async function listSubagentTasks({
  parentSessionId,
  status,
  limit = 50,
}: {
  parentSessionId?: string;
  status?: SubagentTaskStatus;
  limit?: number;
} = {}): Promise<SubagentTask[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const where: Prisma.SubagentTaskWhereInput = {};

  if (parentSessionId !== undefined) {
    where.parentSessionId = sessionIdSchema.parse(parentSessionId);
  }

  if (status !== undefined) {
    where.status = subagentTaskStatusSchema.parse(status);
  }

  const tasks = await prisma.subagentTask.findMany({
    where,
    orderBy: [{ createdAt: "desc" }],
    take: safeLimit,
    select: subagentTaskSelect,
  });

  return tasks.map(toSubagentTask);
}

export async function updateSubagentTask({
  taskId,
  status,
  output,
  error,
}: {
  taskId: string;
  status?: SubagentTaskStatus;
  output?: SubagentTaskOutput;
  error?: string | null;
}): Promise<SubagentTask> {
  const data: Prisma.SubagentTaskUpdateInput = {};

  if (status !== undefined) {
    const validatedStatus = subagentTaskStatusSchema.parse(status);
    data.status = validatedStatus;

    if (validatedStatus === "running") {
      data.startedAt = new Date();
      data.finishedAt = null;
    } else if (terminalSubagentTaskStatuses.has(validatedStatus)) {
      data.finishedAt = new Date();
    }
  }

  if (output !== undefined) {
    data.output = toPrismaNullableJsonValue(output);
  }

  if (error !== undefined) {
    data.error = error;
  }

  try {
    const task = await prisma.subagentTask.update({
      where: { id: taskId },
      data,
      select: subagentTaskSelect,
    });

    return toSubagentTask(task);
  } catch (caught) {
    if (isPrismaRecordNotFoundError(caught)) {
      throw new SubagentTaskNotFoundError(taskId);
    }

    throw caught;
  }
}
