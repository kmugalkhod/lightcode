import { z } from "zod";

const requestUserInputOptionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(240).optional(),
});

export const requestUserInputDescription =
  "Ask the user a focused question while planning. Use this to collect missing requirements or confirm tradeoffs before finalizing a plan.";

export const requestUserInputToolInputSchema = z.object({
  question: z.string().min(1).max(2_000),
  header: z.string().min(1).max(80).optional(),
  options: z.array(requestUserInputOptionSchema).min(1).max(8).optional(),
  allowCustomResponse: z.boolean().optional().default(true),
  placeholder: z.string().min(1).max(200).optional(),
});

// Anthropic tool JSON schema rejects array maxItems/minItems in input_schema.
// Keep runtime validation strict, but relax provider-facing options constraints.
export const requestUserInputToolProviderInputSchema = z.object({
  question: z.string().min(1).max(2_000),
  header: z.string().min(1).max(80).optional(),
  options: z.array(requestUserInputOptionSchema).optional(),
  allowCustomResponse: z.boolean().optional(),
  placeholder: z.string().min(1).max(200).optional(),
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
