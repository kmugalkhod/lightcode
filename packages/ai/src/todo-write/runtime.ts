import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  getDefaultWorkspaceContext,
  resolveWithinWorkspace,
  toWorkspaceRelativePath,
  type WorkspaceContext,
} from "../common/resolve-within-workspace";
import {
  todoItemSchema,
  todoWriteInputSchema,
  todoWriteOutputSchema,
  type TodoItem,
} from "./schema";

type TodoWriteInput = z.input<typeof todoWriteInputSchema>;
type TodoWriteOutput = z.infer<typeof todoWriteOutputSchema>;

const defaultSessionId = "default";

function safeTodoSessionId(sessionId: string | undefined) {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    return defaultSessionId;
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function getTodoFilePath(
  sessionId: string | undefined,
  workspaceContext: WorkspaceContext,
) {
  return resolveWithinWorkspace(
    path.join(".lightcode", "todos", `${safeTodoSessionId(sessionId)}.json`),
    {
      context: workspaceContext,
      allowMissing: true,
    },
  );
}

function summarizeTodos(todos: TodoItem[]): TodoWriteOutput["summary"] {
  return {
    total: todos.length,
    pending: todos.filter((todo) => todo.status === "pending").length,
    inProgress: todos.filter((todo) => todo.status === "in_progress").length,
    completed: todos.filter((todo) => todo.status === "completed").length,
    canceled: todos.filter((todo) => todo.status === "canceled").length,
  };
}

export async function loadSessionTodos({
  sessionId,
  workspaceContext = getDefaultWorkspaceContext(),
}: {
  sessionId?: string;
  workspaceContext?: WorkspaceContext;
} = {}) {
  const todoFilePath = getTodoFilePath(sessionId, workspaceContext);

  try {
    const rawTodos = JSON.parse(await readFile(todoFilePath, "utf8"));
    return z.array(todoItemSchema).parse(rawTodos);
  } catch {
    return [];
  }
}

export async function executeTodoWrite(
  input: TodoWriteInput,
  {
    sessionId,
    workspaceContext = getDefaultWorkspaceContext(),
  }: {
    sessionId?: string;
    workspaceContext?: WorkspaceContext;
  } = {},
): Promise<TodoWriteOutput> {
  const parsedInput = todoWriteInputSchema.parse(input);
  const todoFilePath = getTodoFilePath(sessionId, workspaceContext);
  const todos = parsedInput.todos.map((todo, index) =>
    todoItemSchema.parse({
      ...todo,
      id: todo.id ?? `todo-${index + 1}`,
    }),
  );

  await mkdir(path.dirname(todoFilePath), { recursive: true });
  await writeFile(todoFilePath, JSON.stringify(todos, null, 2), "utf8");

  return todoWriteOutputSchema.parse({
    sessionId: safeTodoSessionId(sessionId),
    path: toWorkspaceRelativePath(todoFilePath, workspaceContext),
    todos,
    summary: summarizeTodos(todos),
  });
}
