import { z } from "zod";

const requestUserInputOptionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(240).optional(),
});

export const requestUserInputDescription =
  "Ask the user a question and wait for the answer. Use it only when a decision is genuinely the user's to make and you cannot settle it from the request, the code, or a sensible default — " +
  "never to ask permission to continue or to confirm what you are about to do. When the answer is a choice, offer 2-4 options (a short label, optionally a one-line description); " +
  "the user can always type their own answer instead. header is an optional short title of a few words.";

export const requestUserInputToolInputSchema = z.object({
  question: z.string().min(1).max(2_000),
  header: z.string().min(1).max(80).optional(),
  // An empty list means a free-text question.
  options: z.array(requestUserInputOptionSchema).max(8).optional(),
  allowCustomResponse: z.boolean().optional().default(true),
  placeholder: z.string().min(1).max(200).optional(),
});

// Sent without strict mode (see the registry): strict grammars cannot carry
// the options array. Array bounds stay out of the provider schema because
// some providers reject minItems/maxItems; the runtime schema enforces them.
export const requestUserInputToolProviderInputSchema = z.object({
  question: z.string().min(1).max(2_000),
  header: z.string().min(1).max(80).optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        description: z.string().min(1).max(240).optional(),
      }),
    )
    .optional(),
});

export const requestUserInputToolOutputSchema = z.object({
  answer: z.string().min(1).max(4_000),
  selectedOption: z.string().min(1).max(120).optional(),
  source: z.enum(["option", "custom"]),
});

export type RequestUserInputToolInput = z.infer<
  typeof requestUserInputToolInputSchema
>;

export type RequestUserInputToolOutput = z.infer<
  typeof requestUserInputToolOutputSchema
>;
