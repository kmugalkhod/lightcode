import { z } from "zod";

export const homeRouteStateSchema = z.null();
export const chatRouteStateSchema = z.object({
  input: z.string(),
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

export function getDefaultRouteState(view: "home"): RouteStateByView["home"];
export function getDefaultRouteState(view: "chat"): RouteStateByView["chat"];
export function getDefaultRouteState(view: ViewId): RouteState;
export function getDefaultRouteState(view: ViewId) {
  if (view === "home") {
    return null;
  }

  return { input: "" };
}

export function coerceRouteState(view: "home", value: unknown): RouteStateByView["home"];
export function coerceRouteState(view: "chat", value: unknown): RouteStateByView["chat"];
export function coerceRouteState(view: ViewId, value: unknown): RouteState;
export function coerceRouteState(view: ViewId, value: unknown) {
  if (view === "home") {
    const parsed = homeRouteStateSchema.safeParse(value);
    return parsed.success ? parsed.data : getDefaultRouteState("home");
  }

  const parsed = chatRouteStateSchema.safeParse(value);
  return parsed.success ? parsed.data : getDefaultRouteState("chat");
}
