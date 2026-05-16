import { z } from "zod";

export const sessionRouteLocationStateSchema = z.object({
  input: z.string().optional(),
  skipHistoryLoad: z.boolean().optional(),
});

export type SessionRouteLocationState = z.infer<typeof sessionRouteLocationStateSchema>;

export function coerceSessionRouteLocationState(value: unknown): SessionRouteLocationState {
  const parsed = sessionRouteLocationStateSchema.safeParse(value);

  if (!parsed.success) {
    return {};
  }

  return parsed.data;
}
