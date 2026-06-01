import { z } from "zod";

export const todoWriteDescription =
  "Persist the current session task list. Use this to track multi-step coding work and update task status as progress changes.";

export const todoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "canceled",
]);

export const todoPrioritySchema = z.enum(["low", "medium", "high"]);

export const todoItemSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  content: z.string().min(1).max(500),
  status: todoStatusSchema,
  priority: todoPrioritySchema.optional().default("medium"),
  notes: z.string().max(1000).optional(),
});

const todoItemProviderSchema = z.object({
  content: z.string().min(1).max(500),
  status: todoStatusSchema,
});

export const todoWriteInputSchema = z.object({
  todos: z.array(todoItemSchema).max(50),
});

export const todoWriteProviderInputSchema = z.object({
  todos: z.array(todoItemProviderSchema),
});

export const todoWriteOutputSchema = z.object({
  sessionId: z.string(),
  path: z.string(),
  todos: z.array(todoItemSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
  }),
});

export type TodoItem = z.infer<typeof todoItemSchema>;
