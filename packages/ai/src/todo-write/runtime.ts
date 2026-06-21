import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TODO_CONTENT_MAX_CHARS } from "../constants";
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

function truncateContent(content: string): string {
  if (content.length <= TODO_CONTENT_MAX_CHARS) {
    return content;
  }

  return `${content.slice(0, TODO_CONTENT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Normalize the submitted list so the rendered card always reflects a valid
 * state, and collect non-fatal warnings the model sees on its next call.
 * Corrective, never destructive: we never throw (that would break the agent
 * loop and lose the card) and never silently revert legitimate reopens.
 */
function validateTodoInvariants(
  todos: TodoItem[],
  previousTodos: TodoItem[],
): { todos: TodoItem[]; warnings: string[] } {
  const warnings: string[] = [];

  // Content cap — keep items terse.
  let normalized = todos.map((todo) => {
    const capped = truncateContent(todo.content);
    if (capped !== todo.content) {
      warnings.push(
        `Todo "${capped}" was longer than ${TODO_CONTENT_MAX_CHARS} characters and was truncated; keep items terse.`,
      );
    }
    return capped === todo.content ? todo : { ...todo, content: capped };
  });

  // Exactly one in_progress — demote extras (keep the first) to pending.
  const inProgress = normalized.filter((todo) => todo.status === "in_progress");
  if (inProgress.length > 1) {
    let seen = false;
    normalized = normalized.map((todo) => {
      if (todo.status !== "in_progress") {
        return todo;
      }
      if (!seen) {
        seen = true;
        return todo;
      }
      return { ...todo, status: "pending" as const };
    });
    warnings.push(
      `${inProgress.length} tasks were in_progress; kept "${inProgress[0].content}" and reset the rest to pending. Keep exactly one task in_progress.`,
    );
  } else if (
    inProgress.length === 0 &&
    normalized.some((todo) => todo.status === "pending")
  ) {
    warnings.push(
      "No task is in_progress but pending work remains; mark the next task in_progress before starting it.",
    );
  }

  // Monotonic completion — flag (don't revert) completed items that regressed.
  const previouslyCompleted = new Map(
    previousTodos
      .filter((todo) => todo.status === "completed")
      .map((todo) => [todo.id ?? todo.content, todo] as const),
  );
  for (const todo of normalized) {
    const key = todo.id ?? todo.content;
    if (
      previouslyCompleted.has(key) &&
      todo.status !== "completed" &&
      todo.status !== "canceled"
    ) {
      warnings.push(
        `Task "${todo.content}" was completed earlier but is now ${todo.status}; completions should be monotonic. Reopen only if it genuinely regressed.`,
      );
    }
  }

  return { todos: normalized, warnings };
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
  const submitted = parsedInput.todos.map((todo, index) =>
    todoItemSchema.parse({
      ...todo,
      id: todo.id ?? `todo-${index + 1}`,
    }),
  );

  const previousTodos = await loadSessionTodos({ sessionId, workspaceContext });
  const { todos, warnings } = validateTodoInvariants(submitted, previousTodos);

  await mkdir(path.dirname(todoFilePath), { recursive: true });
  await writeFile(todoFilePath, JSON.stringify(todos, null, 2), "utf8");

  return todoWriteOutputSchema.parse({
    sessionId: safeTodoSessionId(sessionId),
    path: toWorkspaceRelativePath(todoFilePath, workspaceContext),
    todos,
    summary: summarizeTodos(todos),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
