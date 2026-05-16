import { z } from "zod";

export const sessionCreateResponseSchema = z.object({
  id: z.string().min(1),
});

export const sessionMessagesResponseSchema = z.object({
  messages: z.unknown(),
});
