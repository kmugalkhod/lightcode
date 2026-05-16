import { z } from "zod";

export const chatSessionHistoryResponseSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.unknown(),
});
