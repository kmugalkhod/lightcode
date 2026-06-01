import { codingAgentModeSchema, permissionModeSchema } from "@lightcode/ai";
import { z } from "zod";

export const sessionRouteLocationStateSchema = z.object({
  input: z.string().optional(),
  skipHistoryLoad: z.boolean().optional(),
  mode: codingAgentModeSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
});

export type SessionRouteLocationState = z.infer<typeof sessionRouteLocationStateSchema>;

export function coerceSessionRouteLocationState(value: unknown): SessionRouteLocationState {
  const parsed = sessionRouteLocationStateSchema.safeParse(value);

  if (!parsed.success) {
    return {};
  }

  return parsed.data;
}
