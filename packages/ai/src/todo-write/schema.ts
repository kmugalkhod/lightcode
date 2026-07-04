import { z } from "zod";
import {
  TODO_ACTIVE_FORM_MAX_CHARS,
  TODO_CONTENT_MAX_CHARS,
} from "../constants";

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
  content: z.string().min(1).max(TODO_CONTENT_MAX_CHARS),
  status: todoStatusSchema,
  priority: todoPrioritySchema.optional().default("medium"),
  notes: z.string().max(1000).optional(),
  activeForm: z
    .string()
    .min(1)
    .max(TODO_ACTIVE_FORM_MAX_CHARS)
    .optional(),
});

// Provider-facing schema: terser shape (no id/priority/notes) so each
// full-rewrite stays small. Content caps match todoItemSchema via the shared
// TODO_CONTENT_MAX_CHARS constant. activeForm is exposed here (with a
// description the model reads) so it sets a present-tense label for the
// in_progress item; the UI falls back to content when absent.
const todoItemProviderSchema = z.object({
  content: z.string().min(1).max(TODO_CONTENT_MAX_CHARS),
  status: todoStatusSchema,
  activeForm: z
    .string()
    .min(1)
    .max(TODO_ACTIVE_FORM_MAX_CHARS)
    .optional()
    .describe(
      'Present-tense label shown while in_progress, e.g. "Adding tests".',
    ),
});

export const todoWriteInputSchema = z.object({
  todos: z.array(todoItemSchema).max(50),
});

export const todoWriteProviderInputSchema = z.object({
  todos: z.array(todoItemProviderSchema).max(20),
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
  // Non-fatal corrections applied to the submitted list (e.g. extra
  // in_progress items demoted, completions regressed, content truncated).
  // Fed back to the model so it can self-correct on the next call.
  warnings: z.array(z.string()).optional(),
});

export type TodoItem = z.infer<typeof todoItemSchema>;
