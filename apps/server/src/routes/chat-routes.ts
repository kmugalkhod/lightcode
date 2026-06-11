import { zValidator } from "@hono/zod-validator";
import {
  buildProviderView,
  codingChatRequestSchema,
  chatInteractionListQuerySchema,
  chatInteractionResolveRequestSchema,
  chatInteractionUpsertRequestSchema,
  concreteSessionInteractionPathParamsSchema,
  concreteSessionPathParamsSchema,
  sessionInteractionPathParamsSchema,
  sessionCreateRequestSchema,
  sessionPathParamsSchema,
  sessionUpdateRequestSchema,
} from "@lightcode/ai";
import { Hono } from "hono";
import {
  ChatInteractionNotFoundError,
  listChatInteractions,
  resolveChatInteraction,
  upsertChatInteraction,
} from "../lib/chat-interaction-store";
import {
  createChatSession,
  deleteChatSession,
  exportChatSessionJson,
  forkChatSession,
  listChatSessions,
  loadChatSessionWithMessages,
  renameChatSession,
  resolveChatSessionIdentifier,
  updateSessionMetadata,
  SessionNotFoundError,
} from "../lib/chat-store";
import {
  loadSessionContextStateSafe,
  streamSessionChat,
} from "../lib/chat-stream";
import { compactSessionContext } from "../lib/context-compaction";
import { getSessionContextState } from "../lib/context-state-store";
import {
  chatModelId,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "../lib/runtime-config";
import { internalErrorResponse } from "./route-helpers";

export const sessionRoutes = new Hono()
  .get("/", async (c) => {
    try {
      const sessions = await listChatSessions();
      return c.json({ sessions });
    } catch (error) {
      return internalErrorResponse(c, {
        event: "session_list_failed",
        message: "Unable to list chat sessions.",
        error,
      });
    }
  })
  .post("/", zValidator("json", sessionCreateRequestSchema), async (c) => {
    const body = c.req.valid("json");

    try {
      const session = await createChatSession({
        cwd: body.cwd,
        mode: body.mode ?? lightcodeConfigResult.config.defaultMode,
        permissionMode:
          body.permissionMode ?? lightcodeConfigResult.config.permissionMode ?? null,
        model: chatModelId,
        title: body.title,
      });
      return c.json(session, 201);
    } catch (error) {
      return internalErrorResponse(c, {
        event: "session_create_failed",
        message: "Unable to create chat session.",
        error,
      });
    }
  })
  .get("/:id", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      const sessionWithMessages = await loadChatSessionWithMessages(id);
      const contextState = await loadSessionContextStateSafe(
        sessionWithMessages.session.id,
      );
      return c.json({ ...sessionWithMessages, contextState });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      return internalErrorResponse(c, {
        event: "session_resume_failed",
        message: "Unable to resume chat session.",
        error,
      });
    }
  })
  .get("/:id/messages", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      const sessionWithMessages = await loadChatSessionWithMessages(id);
      const contextState = await loadSessionContextStateSafe(
        sessionWithMessages.session.id,
      );
      return c.json({ ...sessionWithMessages, contextState });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      return internalErrorResponse(c, {
        event: "session_messages_load_failed",
        message: "Unable to load persisted chat messages.",
        error,
      });
    }
  })
  .get("/:id/context", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      const sessionId = await resolveChatSessionIdentifier(id);
      const { messages } = await loadChatSessionWithMessages(sessionId);
      const contextState = await getSessionContextState(sessionId);
      const view = buildProviderView({
        messages,
        contextState,
        config: lightcodeConfigResult.config.context,
        modelContextWindow: resolvedProviderModel.contextWindow,
      });

      return c.json({
        contextState,
        estimate: view.estimate,
        contextWindow: view.contextWindow,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      return internalErrorResponse(c, {
        event: "session_context_load_failed",
        message: "Unable to load session context state.",
        error,
      });
    }
  })
  .post("/:id/compact", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      const sessionId = await resolveChatSessionIdentifier(id);
      const { session, messages } = await loadChatSessionWithMessages(sessionId);
      const contextState = await getSessionContextState(sessionId);
      const contextConfig = lightcodeConfigResult.config.context;
      const view = buildProviderView({
        messages,
        contextState,
        config: contextConfig,
        modelContextWindow: resolvedProviderModel.contextWindow,
      });

      if (view.coveredMessages.length === 0) {
        return c.json(
          { error: "Not enough new messages to compact yet." },
          409,
        );
      }

      const compaction = await compactSessionContext({
        sessionId,
        coveredMessages: view.coveredMessages,
        previousState: contextState,
        model: resolvedProviderModel.model,
        modelId: chatModelId,
        cwd: session.cwd ?? undefined,
        config: contextConfig,
        estimatedTokens: view.estimate.tokens,
      });

      return c.json(
        {
          contextState: compaction.state,
          usedFallback: compaction.usedFallback,
        },
        201,
      );
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      return internalErrorResponse(c, {
        event: "session_compact_failed",
        message: "Unable to compact session context.",
        error,
      });
    }
  })
  .get(
    "/:id/interactions",
    zValidator("param", sessionInteractionPathParamsSchema),
    zValidator("query", chatInteractionListQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");

      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return c.json(
          await listChatInteractions({
            sessionId,
            status: query.status,
            kind: query.kind,
          }),
        );
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }

        return internalErrorResponse(c, {
          event: "interaction_list_failed",
          message: "Unable to list chat interactions.",
          error,
        });
      }
    }
  )
  .post(
    "/:id/interactions",
    zValidator("param", sessionInteractionPathParamsSchema),
    zValidator("json", chatInteractionUpsertRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return c.json(await upsertChatInteraction({ sessionId, ...body }), 201);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }

        return internalErrorResponse(c, {
          event: "interaction_upsert_failed",
          message: "Unable to checkpoint chat interaction.",
          error,
        });
      }
    }
  )
  .patch(
    "/:id/interactions/:toolCallId",
    zValidator("param", concreteSessionInteractionPathParamsSchema),
    zValidator("json", chatInteractionResolveRequestSchema),
    async (c) => {
      const { id, toolCallId } = c.req.valid("param");
      const body = c.req.valid("json");

      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return c.json(
          await resolveChatInteraction({
            sessionId,
            toolCallId,
            ...body,
          }),
        );
      } catch (error) {
        if (
          error instanceof SessionNotFoundError ||
          error instanceof ChatInteractionNotFoundError
        ) {
          return c.json({ error: error.message }, 404);
        }

        return internalErrorResponse(c, {
          event: "interaction_resolve_failed",
          message: "Unable to resolve chat interaction.",
          error,
        });
      }
    }
  )
  .get("/:id/export", zValidator("param", sessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      return c.json(await exportChatSessionJson(id));
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      return internalErrorResponse(c, {
        event: "session_export_failed",
        message: "Unable to export chat session.",
        error,
      });
    }
  })
  .patch(
    "/:id",
    zValidator("param", concreteSessionPathParamsSchema),
    zValidator("json", sessionUpdateRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      // If only title is provided, use renameChatSession for backward compatibility
      if (body.title !== undefined && body.permissionMode === undefined) {
        try {
          return c.json(await renameChatSession(id, body.title));
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            return c.json({ error: error.message }, 404);
          }
          return internalErrorResponse(c, {
            event: "session_rename_failed",
            message: "Unable to rename chat session.",
            error,
          });
        }
      }

      // Otherwise use updateSessionMetadata for title and/or permission mode
      try {
        return c.json(
          await updateSessionMetadata(id, {
            title: body.title,
            permissionMode: body.permissionMode,
          }),
        );
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        return internalErrorResponse(c, {
          event: "session_update_failed",
          message: "Unable to update session metadata.",
          error,
        });
      }
    },
  )
  .post(
    "/:id/fork",
    zValidator("param", sessionPathParamsSchema),
    async (c) => {
      const { id } = c.req.valid("param");

      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return c.json(await forkChatSession(sessionId), 201);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }

        return internalErrorResponse(c, {
          event: "session_fork_failed",
          message: "Unable to fork chat session.",
          error,
        });
      }
    },
  )
  .delete("/:id", zValidator("param", concreteSessionPathParamsSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
      return c.json(await deleteChatSession(id));
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }

      return internalErrorResponse(c, {
        event: "session_delete_failed",
        message: "Unable to delete chat session.",
        error,
      });
    }
  })
  .post(
    "/:id/chat",
    zValidator("param", sessionPathParamsSchema),
    zValidator("json", codingChatRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      return streamSessionChat(
        c,
        id,
        body.messages,
        body.cwd,
        body.mode ?? lightcodeConfigResult.config.defaultMode,
        body.permissionMode ?? lightcodeConfigResult.config.permissionMode,
        body.allowedTools ?? lightcodeConfigResult.config.allowedTools,
        body.permissionRules ?? lightcodeConfigResult.config.permissions,
        body.sandbox ?? lightcodeConfigResult.config.sandbox,
      );
    }
  );
