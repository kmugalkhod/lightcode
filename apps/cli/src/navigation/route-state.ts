import { z } from "zod";

export const homeRouteStateSchema = z.null();
export const chatRouteStateSchema = z.object({
  input: z.string(),
  sessionId: z.string().min(1),
  skipHistoryLoad: z.boolean().optional(),
});

export const routeStateSchemas = {
  home: homeRouteStateSchema,
  chat: chatRouteStateSchema,
} as const;

export type ViewId = keyof typeof routeStateSchemas;

export type RouteStateByView = {
  [K in ViewId]: z.infer<(typeof routeStateSchemas)[K]>;
};

export type RouteState = RouteStateByView[ViewId];
export type ChatRouteState = RouteStateByView["chat"];

export function getDefaultRouteState<K extends ViewId>(view: K): RouteStateByView[K] {
  if (view === "home") {
    return null as RouteStateByView[K];
  }

  return {
    input: "",
    sessionId: crypto.randomUUID(),
    skipHistoryLoad: false,
  } as RouteStateByView[K];
}

export function coerceRouteState<K extends ViewId>(view: K, value: unknown): RouteStateByView[K] {
  if (view === "home") {
    const parsed = homeRouteStateSchema.safeParse(value);
    return (parsed.success ? parsed.data : getDefaultRouteState("home")) as RouteStateByView[K];
  }

  const parsed = chatRouteStateSchema.safeParse(value);
  return (parsed.success ? parsed.data : getDefaultRouteState("chat")) as RouteStateByView[K];
}
