import { zValidator } from "@hono/zod-validator";
import {
  artifactizeLargeToolOutputs,
  buildProviderView,
  createCodingAgentTools,
  codingChatRequestSchema,
  chatInteractionListQuerySchema,
  chatInteractionResolveRequestSchema,
  chatInteractionUpsertRequestSchema,
  concreteSessionInteractionPathParamsSchema,
  concreteSessionPathParamsSchema,
  estimateStructuralTokens,
  lightcodeConfigDefaults,
  normalizeProviderMessages,
  ProviderTurnAssembler,
  resolveCodingAgentCallSettings,
  resolveContextWindowTokens,
  resolveMaxOutputTokens,
  selectCodingAgentIntentTools,
  sessionAbortRunResponseSchema,
  sessionTurnHistoryActionResponseSchema,
  sessionInteractionPathParamsSchema,
  sessionCreateRequestSchema,
  sessionPathParamsSchema,
  sessionRunEventsQuerySchema,
  sessionRunPathParamsSchema,
  sessionTurnRequestSchema,
  sessionUpdateRequestSchema,
  type SessionContextState,
  type SessionMetadata,
} from "@lightcode/ai";
import { getErrorMessage } from "@lightcode/shared";
import { Hono, type Context } from "hono";
import { convertToModelMessages, type UIMessage } from "ai";
import {
  ChatInteractionNotFoundError,
  listChatInteractions,
  resolveChatInteraction,
  upsertChatInteraction,
} from "../lib/chat-interaction-store";
import {
  CheckpointConflictError,
  clearSessionRedoBranch,
  redoSessionTurn,
  SessionHistoryConflictError,
  undoSessionTurn,
} from "../lib/chat-history-store";
import {
  assertSessionWorkspaceIdentity,
  createChatSession,
  deleteChatSession,
  exportChatSessionJson,
  forkChatSession,
  listChatSessions,
  loadChatSessionWithMessages,
  mergeSessionTurnDelta,
  renameChatSession,
  resolveChatSessionIdentifier,
  updateSessionMetadata,
  SessionNotFoundError,
  SessionWorkspaceIdentityError,
} from "../lib/chat-store";
import {
  abortActiveRun,
  createChatRun,
  getActiveRunId,
  getChatRun,
  getChatRunByClientTurnId,
  listChatRunEvents,
  registerActiveRun,
  releaseActiveRun,
  SessionRevisionConflictError,
  SessionRunConflictError,
  updateChatRun,
} from "../lib/chat-run-store";
import {
  createOrderedRunEventRecorder,
  releaseOrderedRunEventRecorder,
  type OrderedRunEventRecorder,
} from "../lib/chat-run-event-recorder";
import {
  captureChatRunResponse,
  finalizeChatRun,
  replayChatRunResponse,
  resumeChatRunResponse,
} from "../lib/chat-run-stream";
import {
  providerWebSearchApprovalRequiredBody,
  resolveProviderWebSearchGate,
} from "../lib/provider-web-search-gate";
import {
  loadSessionContextStateSafe,
  streamSessionChat,
} from "../lib/chat-stream";
import { materializeProviderAttachments } from "../lib/attachment-store";
import { compactSessionContext } from "../lib/context-compaction";
import { getSessionContextState } from "../lib/context-state-store";
import { getLearnedContextLimit } from "../lib/learned-context-limit";
import {
  chatModelId,
  lightcodeConfigResult,
  resolvedProviderModel,
} from "../lib/runtime-config";
import {
  buildWorkspaceContext,
  buildWorkspaceContextDelta,
  collectRelatedWorkspacePaths,
} from "../lib/workspace-context";
import { internalErrorResponse } from "./route-helpers";

function sessionWorkspaceErrorResponse(
  c: Context,
  error: SessionWorkspaceIdentityError,
) {
  return c.json(
    { error: error.message, code: error.code },
    error.code === "workspace_unavailable" ? 404 : 409,
  );
}

async function assembleStoredSessionProviderTurn({
  session,
  messages,
  contextState,
  abortSignal,
}: {
  session: SessionMetadata;
  messages: UIMessage[];
  contextState: SessionContextState | null;
  abortSignal?: AbortSignal;
}) {
  if (!session.cwd) {
    throw new Error("Session has no canonical workspace directory.");
  }
  await assertSessionWorkspaceIdentity(session.id);

  const providerMessages = await materializeProviderAttachments({
    messages,
    cwd: session.cwd,
  });

  const environmentContext = messages.some(
    (message) => message.role === "assistant",
  )
    ? await buildWorkspaceContextDelta({
        cwd: session.cwd,
        sessionId: session.id,
        relatedPaths: collectRelatedWorkspacePaths(messages),
      })
    : await buildWorkspaceContext({
        cwd: session.cwd,
        sessionId: session.id,
        relatedPaths: collectRelatedWorkspacePaths(messages),
      });
  const callSettings = resolveCodingAgentCallSettings({
    options: {
      cwd: session.cwd,
      sessionId: session.id,
      mode: session.mode,
      permissionMode:
        session.permissionMode ??
        lightcodeConfigResult.config.permissionMode ??
        undefined,
      allowedTools: lightcodeConfigResult.config.allowedTools,
      permissionRules: lightcodeConfigResult.config.permissions,
      sandbox: lightcodeConfigResult.config.sandbox,
      environmentContext,
    },
    prompt: undefined,
    messages: providerMessages,
    promptOverride: Bun.env.LIGHTCODE_CODING_AGENT_SYSTEM_PROMPT,
    includeToolDiscipline:
      resolvedProviderModel.needsToolCallDiscipline ?? false,
    providerWebSearchTool: Boolean(
      resolvedProviderModel.providerTools?.web_search,
    ),
  });
  const tools = createCodingAgentTools();
  if (!resolvedProviderModel.webSearchCapability.available) {
    delete tools.web_search;
  } else if (
    resolvedProviderModel.providerTools?.web_search &&
    callSettings.providerWebSearchAccess?.action === "expose"
  ) {
    tools.web_search = resolvedProviderModel.providerTools.web_search;
  } else if (resolvedProviderModel.providerTools?.web_search) {
    delete tools.web_search;
  }
  const activeTools = callSettings.activeTools.filter(
    (toolName) => tools[toolName] !== undefined,
  );
  const endpointLimitTokens = getLearnedContextLimit(chatModelId);
  const contextWindow = resolveContextWindowTokens({
    config: lightcodeConfigResult.config.context,
    modelContextWindow: resolvedProviderModel.contextWindow,
    endpointLimitTokens,
  });
  const reservedOutputTokens = Math.min(
    resolveMaxOutputTokens(
      lightcodeConfigResult.config.maxOutputTokens,
      lightcodeConfigDefaults.maxOutputTokens,
      resolvedProviderModel.maxCompletionTokens,
    ),
    Math.max(1_024, Math.floor(contextWindow / 2)),
  );
  const baseAssembler = new ProviderTurnAssembler({
    system: callSettings.instructions,
    tools,
    activeTools,
    contextWindow,
    reservedOutputTokens,
  });
  const view = buildProviderView({
    messages: providerMessages,
    contextState,
    config: lightcodeConfigResult.config.context,
    modelContextWindow: resolvedProviderModel.contextWindow,
    endpointLimitTokens,
    reservedOutputTokens,
    cacheActive: resolvedProviderModel.supportsPromptCaching,
    fixedInputTokens: baseAssembler.fixedInputTokens,
  });
  const assembler = new ProviderTurnAssembler({
    system: callSettings.instructions,
    tools,
    activeTools,
    contextWindow: view.contextWindow,
    reservedOutputTokens,
    originalInputTokens:
      estimateStructuralTokens(providerMessages) + baseAssembler.fixedInputTokens,
  });
  const modelMessages = await convertToModelMessages(
    normalizeProviderMessages(view.providerMessages),
    { tools },
  );
  const artifactized = await artifactizeLargeToolOutputs(modelMessages, {
    signal: abortSignal,
  });
  const assembled = assembler.assembleModelMessages(
    artifactized.messages,
    { preserveRecentTokens: view.preserveRecentTokens },
  );
  return { view, assembled };
}

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
      if (error instanceof SessionWorkspaceIdentityError) {
        return sessionWorkspaceErrorResponse(c, error);
      }
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
      if (error instanceof SessionWorkspaceIdentityError) {
        return sessionWorkspaceErrorResponse(c, error);
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
      const { session, messages } = await loadChatSessionWithMessages(sessionId);
      const contextState = await getSessionContextState(sessionId);
      const { assembled } = await assembleStoredSessionProviderTurn({
        session,
        messages,
        contextState,
        abortSignal: c.req.raw.signal,
      });

      return c.json({
        contextState,
        estimate: {
          tokens: assembled.breakdown.inputTokens,
          basis: "heuristic" as const,
        },
        contextWindow: assembled.breakdown.contextWindow,
        breakdown: assembled.breakdown,
        withinBudget: assembled.withinBudget,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof SessionWorkspaceIdentityError) {
        return sessionWorkspaceErrorResponse(c, error);
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
      const activeRunId = getActiveRunId(sessionId);
      if (activeRunId) {
        return c.json(
          {
            error: "Abort the active run before compacting this session.",
            code: "run_conflict",
            activeRunId,
          },
          409,
        );
      }
      const { session, messages } = await loadChatSessionWithMessages(sessionId);
      const contextState = await getSessionContextState(sessionId);
      const contextConfig = lightcodeConfigResult.config.context;
      const { view, assembled } = await assembleStoredSessionProviderTurn({
        session,
        messages,
        contextState,
        abortSignal: c.req.raw.signal,
      });

      if (view.coveredMessages.length === 0) {
        return c.json(
          { error: "Not enough new messages to compact yet." },
          409,
        );
      }

      await assertSessionWorkspaceIdentity(sessionId);
      const compaction = await compactSessionContext({
        sessionId,
        coveredMessages: view.coveredMessages,
        previousState: contextState,
        model: resolvedProviderModel.model,
        modelId: chatModelId,
        cwd: session.cwd ?? undefined,
        config: contextConfig,
        estimatedTokens: assembled.breakdown.inputTokens,
        contextWindow: assembled.breakdown.contextWindow,
        abortSignal: c.req.raw.signal,
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
      if (error instanceof SessionWorkspaceIdentityError) {
        return sessionWorkspaceErrorResponse(c, error);
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
    "/:id/turns",
    zValidator("param", sessionPathParamsSchema),
    zValidator("json", sessionTurnRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");

      let sessionId: string;
      try {
        sessionId = await resolveChatSessionIdentifier(id);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        throw error;
      }

      const activeRunId = getActiveRunId(sessionId);
      if (activeRunId) {
        return c.json(
          {
            error: "This session already has an active run.",
            code: "run_conflict",
            activeRunId,
          },
          409,
        );
      }

      // A retry of an already-admitted turn is a read-only replay, not a new
      // provider request. Resolve it before revision/approval preflight so the
      // original base revision and one-turn decision need not be resubmitted.
      const existingRun = await getChatRunByClientTurnId({
        sessionId,
        clientTurnId: body.clientTurnId,
      });
      if (existingRun) {
        if (
          existingRun.status === "running" ||
          existingRun.status === "pending"
        ) {
          return c.json(
            {
              error: "The same turn is already running.",
              code: "run_conflict",
              activeRunId: existingRun.id,
            },
            409,
          );
        }
        return replayChatRunResponse({ sessionId, runId: existingRun.id });
      }

      // Provider-executed tools can perform the search (and incur billing)
      // inside the generation request. Resolve their permission before a run,
      // event, message, or redo-branch mutation is persisted.
      let preflightSession: Awaited<
        ReturnType<typeof loadChatSessionWithMessages>
      >;
      try {
        preflightSession = await loadChatSessionWithMessages(sessionId);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        throw error;
      }
      if (preflightSession.session.revision !== body.expectedRevision) {
        return c.json(
          {
            error: `Session revision conflict: expected ${body.expectedRevision}, current revision is ${preflightSession.session.revision}.`,
            code: "revision_conflict",
            expectedRevision: body.expectedRevision,
            actualRevision: preflightSession.session.revision,
          },
          409,
        );
      }
      try {
        await assertSessionWorkspaceIdentity(sessionId);
      } catch (error) {
        if (error instanceof SessionWorkspaceIdentityError) {
          return sessionWorkspaceErrorResponse(c, error);
        }
        throw error;
      }
      const providerWebSearchGate = resolveProviderWebSearchGate({
        capability: resolvedProviderModel.webSearchCapability,
        providerToolAvailable: Boolean(
          resolvedProviderModel.providerTools?.web_search,
        ),
        requested: selectCodingAgentIntentTools({
          mode: body.mode ?? preflightSession.session.mode,
          prompt: undefined,
          messages: [
            ...preflightSession.messages,
            {
              id: body.messageId,
              role: body.role,
              parts: body.parts,
              ...(body.metadata === undefined
                ? {}
                : { metadata: body.metadata }),
            },
          ],
        }).includes("web_search"),
        mode: body.mode ?? preflightSession.session.mode,
        permissionMode:
          body.permissionMode ??
          preflightSession.session.permissionMode ??
          undefined,
        allowedTools:
          body.allowedTools ?? lightcodeConfigResult.config.allowedTools,
        permissionRules:
          body.permissionRules ?? lightcodeConfigResult.config.permissions,
        decision: body.providerWebSearchDecision,
      });
      if (providerWebSearchGate.action === "approval-required") {
        return c.json(providerWebSearchApprovalRequiredBody(), 428);
      }

      let runId: string | null = null;
      let runSignal: AbortSignal | null = null;
      let runRecorder: OrderedRunEventRecorder | null = null;
      try {
        const created = await createChatRun({
          sessionId,
          clientTurnId: body.clientTurnId,
          expectedRevision: body.expectedRevision,
        });
        runId = created.run.id;

        if (created.idempotent) {
          if (created.run.status === "running" || created.run.status === "pending") {
            return c.json(
              {
                error: "The same turn is already running.",
                code: "run_conflict",
                activeRunId: created.run.id,
              },
              409,
            );
          }
          return replayChatRunResponse({ sessionId, runId: created.run.id });
        }

        runSignal = registerActiveRun(sessionId, runId);
        runRecorder = createOrderedRunEventRecorder({ sessionId, runId });
        await runRecorder.record("run_started", {
          clientTurnId: body.clientTurnId,
          baseRevision: body.expectedRevision,
        });
        await updateChatRun({ runId, status: "running" });

        const canonical = await mergeSessionTurnDelta(sessionId, body);
        if (!canonical.session.cwd) {
          throw new Error("Session has no canonical workspace directory.");
        }
        if (canonical.appended) {
          await clearSessionRedoBranch(sessionId);
        }

        const response = await streamSessionChat(
          c,
          sessionId,
          canonical.messages,
          canonical.session.cwd,
          body.mode ?? canonical.session.mode,
          body.permissionMode ?? canonical.session.permissionMode ?? undefined,
          body.allowedTools ?? lightcodeConfigResult.config.allowedTools,
          body.permissionRules ?? lightcodeConfigResult.config.permissions,
          body.sandbox ?? lightcodeConfigResult.config.sandbox,
          {
            abortSignal: runSignal,
            expectedRevision: body.expectedRevision,
            providerWebSearchDecision: body.providerWebSearchDecision,
          },
        );

        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.includes("text/event-stream")) {
          await finalizeChatRun({
            recorder: runRecorder,
            runSignal,
            error: new Error(`Chat request failed with HTTP ${response.status}.`),
          });
          const failedSession = await loadChatSessionWithMessages(sessionId);
          const finalRevision = failedSession.session.revision;
          const headers = new Headers(response.headers);
          headers.set("x-lightcode-run-id", runId);
          headers.set("x-lightcode-revision", String(finalRevision));
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }

        return captureChatRunResponse({
          response,
          recorder: runRecorder,
          runSignal,
        });
      } catch (error) {
        if (runId) {
          try {
            if (runRecorder && runSignal) {
              await finalizeChatRun({
                recorder: runRecorder,
                runSignal,
                error,
              });
            } else {
              releaseActiveRun(sessionId, runId);
              if (runRecorder) {
                releaseOrderedRunEventRecorder(runRecorder);
              }
              await updateChatRun({
                runId,
                status: "failed",
                error: getErrorMessage(error),
              });
            }
          } catch {
            // Preserve the original error response.
          }
        }

        if (error instanceof SessionRevisionConflictError) {
          return c.json(
            {
              error: error.message,
              code: "revision_conflict",
              expectedRevision: error.expectedRevision,
              actualRevision: error.actualRevision,
            },
            409,
          );
        }
        if (error instanceof SessionRunConflictError) {
          return c.json(
            {
              error: error.message,
              code: "run_conflict",
              activeRunId: error.activeRunId,
            },
            409,
          );
        }
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        if (error instanceof SessionWorkspaceIdentityError) {
          return sessionWorkspaceErrorResponse(c, error);
        }
        return internalErrorResponse(c, {
          event: "session_turn_failed",
          message: "Unable to start the session turn.",
          error,
        });
      }
    },
  )
  .post(
    "/:id/undo",
    zValidator("param", sessionPathParamsSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        await assertSessionWorkspaceIdentity(sessionId);
        const activeRunId = getActiveRunId(sessionId);
        if (activeRunId) {
          return c.json(
            {
              error: "Abort the active run before undoing this session.",
              code: "run_conflict",
              activeRunId,
            },
            409,
          );
        }
        const result = await undoSessionTurn(sessionId);
        if (!result) {
          return c.json({ error: "There is no conversation turn to undo." }, 409);
        }
        return c.json(sessionTurnHistoryActionResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        if (
          error instanceof SessionHistoryConflictError ||
          error instanceof CheckpointConflictError
        ) {
          return c.json({ error: error.message, code: "history_conflict" }, 409);
        }
        if (error instanceof SessionWorkspaceIdentityError) {
          return sessionWorkspaceErrorResponse(c, error);
        }
        return internalErrorResponse(c, {
          event: "session_undo_failed",
          message: "Unable to undo the latest session turn.",
          error,
        });
      }
    },
  )
  .post(
    "/:id/redo",
    zValidator("param", sessionPathParamsSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        await assertSessionWorkspaceIdentity(sessionId);
        const activeRunId = getActiveRunId(sessionId);
        if (activeRunId) {
          return c.json(
            {
              error: "Abort the active run before redoing this session.",
              code: "run_conflict",
              activeRunId,
            },
            409,
          );
        }
        const result = await redoSessionTurn(sessionId);
        if (!result) {
          return c.json({ error: "There is no conversation turn to redo." }, 409);
        }
        return c.json(sessionTurnHistoryActionResponseSchema.parse(result));
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        if (
          error instanceof SessionHistoryConflictError ||
          error instanceof CheckpointConflictError
        ) {
          return c.json({ error: error.message, code: "history_conflict" }, 409);
        }
        if (error instanceof SessionWorkspaceIdentityError) {
          return sessionWorkspaceErrorResponse(c, error);
        }
        return internalErrorResponse(c, {
          event: "session_redo_failed",
          message: "Unable to redo the latest session turn.",
          error,
        });
      }
    },
  )
  .get(
    "/:id/runs/stream",
    zValidator("param", sessionPathParamsSchema),
    zValidator("query", sessionRunEventsQuerySchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const { after } = c.req.valid("query");
      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        const runId = getActiveRunId(sessionId);
        if (!runId) {
          return new Response(null, { status: 204 });
        }
        return resumeChatRunResponse({
          sessionId,
          runId,
          after,
          requestSignal: c.req.raw.signal,
        });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        return internalErrorResponse(c, {
          event: "session_run_resume_failed",
          message: "Unable to resume the active session run.",
          error,
        });
      }
    },
  )
  .get(
    "/:id/runs/:runId/stream",
    zValidator("param", sessionRunPathParamsSchema),
    zValidator("query", sessionRunEventsQuerySchema),
    async (c) => {
      const { id, runId } = c.req.valid("param");
      const { after } = c.req.valid("query");
      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        return resumeChatRunResponse({
          sessionId,
          runId,
          after,
          requestSignal: c.req.raw.signal,
        });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        return internalErrorResponse(c, {
          event: "session_run_resume_failed",
          message: "Unable to resume the session run.",
          error,
        });
      }
    },
  )
  .get(
    "/:id/runs/:runId/events",
    zValidator("param", sessionRunPathParamsSchema),
    zValidator("query", sessionRunEventsQuerySchema),
    async (c) => {
      const { id, runId } = c.req.valid("param");
      const { after } = c.req.valid("query");
      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        const result = await listChatRunEvents({ sessionId, runId, after });
        return c.json({
          runId,
          status: result.run.status,
          events: result.events,
          nextCursor: result.nextCursor,
        });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        return internalErrorResponse(c, {
          event: "session_run_events_failed",
          message: "Unable to load run events.",
          error,
        });
      }
    },
  )
  .post(
    "/:id/runs/:runId/abort",
    zValidator("param", sessionRunPathParamsSchema),
    async (c) => {
      const { id, runId } = c.req.valid("param");
      try {
        const sessionId = await resolveChatSessionIdentifier(id);
        const run = await getChatRun({ sessionId, runId });
        if (!run) {
          return c.json({ error: `Run not found: ${runId}` }, 404);
        }

        const aborted = abortActiveRun(sessionId, runId);
        const status = aborted ? "cancelled" : run.status;
        // The background stream pump owns the terminal transition. Marking
        // the row terminal here would make reconnect followers close before
        // the final frames and run_finished event are durably drained.
        return c.json(
          sessionAbortRunResponseSchema.parse({ runId, status, aborted }),
        );
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        return internalErrorResponse(c, {
          event: "session_run_abort_failed",
          message: "Unable to abort the run.",
          error,
        });
      }
    },
  )
  .post(
    "/:id/chat",
    zValidator("param", sessionPathParamsSchema),
    zValidator("json", codingChatRequestSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        const canonical = await loadChatSessionWithMessages(id);
        if (!canonical.session.cwd) {
          return c.json(
            {
              error: "Session has no canonical workspace directory.",
              code: "workspace_unavailable",
            },
            409,
          );
        }

        // Compatibility callers still send `cwd`, but the saved workspace is
        // authoritative. A request must never reopen a session in another tree.
        const mode = body.mode ?? canonical.session.mode;
        const permissionMode =
          body.permissionMode ??
          canonical.session.permissionMode ??
          lightcodeConfigResult.config.permissionMode;
        const allowedTools =
          body.allowedTools ?? lightcodeConfigResult.config.allowedTools;
        const permissionRules =
          body.permissionRules ?? lightcodeConfigResult.config.permissions;
        const gate = resolveProviderWebSearchGate({
          capability: resolvedProviderModel.webSearchCapability,
          providerToolAvailable: Boolean(
            resolvedProviderModel.providerTools?.web_search,
          ),
          requested: selectCodingAgentIntentTools({
            mode,
            prompt: undefined,
            messages: body.messages,
          }).includes("web_search"),
          mode,
          permissionMode,
          allowedTools,
          permissionRules,
          decision: body.providerWebSearchDecision,
        });
        if (gate.action === "approval-required") {
          return c.json(providerWebSearchApprovalRequiredBody(), 428);
        }

        return streamSessionChat(
          c,
          canonical.session.id,
          body.messages,
          canonical.session.cwd,
          mode,
          permissionMode,
          allowedTools,
          permissionRules,
          body.sandbox ?? lightcodeConfigResult.config.sandbox,
          { providerWebSearchDecision: body.providerWebSearchDecision },
        );
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return c.json({ error: error.message }, 404);
        }
        return internalErrorResponse(c, {
          event: "deprecated_session_chat_failed",
          message: "Unable to start the session chat.",
          error,
        });
      }
    }
  );
