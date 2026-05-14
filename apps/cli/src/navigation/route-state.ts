import { z } from "zod";

export const chatRouteStateSchema = z.object({
  input: z.string(),
});

export type ChatRouteState = z.infer<typeof chatRouteStateSchema>;

