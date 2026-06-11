import { z } from "zod";

export const contextStateTierSchema = z.enum(["heuristic", "llm"]);
export type ContextStateTier = z.infer<typeof contextStateTierSchema>;

/**
 * Persisted compaction state for a session. The full message history always
 * stays in the database; this state describes the summary that replaces the
 * prefix of that history in the provider view.
 */
export const sessionContextStateSchema = z.object({
  sessionId: z.string().min(1),
  summary: z.string().min(1),
  /** Id of the last full-history message covered by the summary. */
  anchorMessageId: z.string().min(1),
  /** Total number of full-history messages covered by the summary. */
  coveredMessageCount: z.number().int().positive(),
  /** Estimated tokens of the provider view at the time of compaction. */
  estimatedTokens: z.number().int().nonnegative(),
  tier: contextStateTierSchema,
  model: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SessionContextState = z.infer<typeof sessionContextStateSchema>;

/** The subset of context state needed to build a provider view. */
export type ContextStateView = Pick<
  SessionContextState,
  "summary" | "anchorMessageId" | "coveredMessageCount" | "tier"
>;
