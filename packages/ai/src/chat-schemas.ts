import { z } from "zod";

export const sessionPathParamsSchema = z.object({
  id: z.string().min(1),
});

export const sessionCreateResponseSchema = z.object({
  id: z.string().min(1),
});
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;

export const sessionMessagesResponseSchema = z.object({
  messages: z.array(z.json()),
});
export type SessionMessagesResponse = z.infer<typeof sessionMessagesResponseSchema>;
