import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
  createLightcodeApi,
  type AuthenticatedFetch,
  type LightcodeApi,
  type PermissionMode,
  type ProviderStatus,
  type Session,
} from "./api";
import {
  executeWebCommand,
  type WebCommandExecutionContext,
} from "./web-command-executor";

interface RecordedRequest {
  body: unknown;
  method: string;
  path: string;
}

type MockResponder = (
  request: RecordedRequest,
) => Response | Promise<Response>;

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

function createMockApi(
  responder: MockResponder = () => jsonResponse({}),
): { api: LightcodeApi; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? new URL(input, "http://lightcode.test")
          : input instanceof URL
            ? input
            : new URL(input.url);
      const rawBody = typeof init?.body === "string" ? init.body : null;
      const request = {
        body: rawBody ? JSON.parse(rawBody) : null,
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
      } satisfies RecordedRequest;
      requests.push(request);
      return responder(request);
    },
    { preconnect: (() => undefined) as AuthenticatedFetch["preconnect"] },
  ) satisfies AuthenticatedFetch;

  return { api: createLightcodeApi(fetcher), requests };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    title: "First session",
    cwd: "/workspace/lightcode",
    mode: "build",
    permissionMode: "workspace-write",
    model: "deepseek/deepseek-v3.2",
    revision: 3,
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T09:00:00.000Z",
    ...overrides,
  };
}

function providerStatus(
  overrides: Partial<ProviderStatus> = {},
): ProviderStatus {
  return {
    selectedProvider: "openrouter",
    selectedModel: "deepseek/deepseek-v3.2",
    missingCredentialHints: [],
    ...overrides,
  };
}

function executionContext(
  overrides: Partial<WebCommandExecutionContext> = {},
): WebCommandExecutionContext {
  const { api } = createMockApi();
  return {
    api,
    sessionId: "session-1",
    messages: [] satisfies UIMessage[],
    sessions: [],
    mode: "build",
    permissionMode: "workspace-write",
    providerStatus: providerStatus(),
    isStreaming: false,
    onNewSession: () => undefined,
    onOpenSessions: () => undefined,
    onSelectSession: () => undefined,
    onPermissionModeChange: () => undefined,
    onProviderStatusChange: () => undefined,
    ...overrides,
  };
}

describe("web command executor", () => {
  test("runs navigation callbacks for home, sessions, and latest", async () => {
    const events: string[] = [];
    const latest = session({ title: null, latestUserPromptPreview: "Fix search" });
    const context = executionContext({
      sessions: [latest],
      onNewSession: () => events.push("home"),
      onOpenSessions: () => events.push("sessions"),
      onSelectSession: (selected) => events.push(`select:${selected.id}`),
    });

    const home = await executeWebCommand("home", "", context);
    const sessions = await executeWebCommand("sessions", "", context);
    const selected = await executeWebCommand("latest", "", context);

    expect(events).toEqual(["home", "sessions", "select:session-1"]);
    expect(home).toMatchObject({ title: "New session", tone: "success" });
    expect(sessions.detail).toBe("1 saved session.");
    expect(selected).toEqual({
      title: "Latest session opened",
      detail: "Fix search",
      tone: "success",
    });
  });

  test("reports an empty latest-session list without navigating", async () => {
    let selected = false;
    const result = await executeWebCommand(
      "latest",
      "",
      executionContext({ onSelectSession: () => { selected = true; } }),
    );

    expect(selected).toBe(false);
    expect(result).toEqual({
      title: "No saved sessions",
      detail: "Start a conversation first.",
      tone: "error",
    });
  });

  test("normalizes read, workspace, and full permission aliases", async () => {
    const selected: PermissionMode[] = [];
    const context = executionContext({
      sessionId: undefined,
      onPermissionModeChange: (mode) => selected.push(mode),
    });

    for (const alias of ["read", "readonly", "read-only"]) {
      expect(await executeWebCommand("permission", alias, context)).toMatchObject({
        detail: "read-only",
        tone: "success",
      });
    }
    for (const alias of ["write", "workspace", "workspace-write"]) {
      expect(await executeWebCommand("permission", alias, context)).toMatchObject({
        detail: "workspace-write",
        tone: "success",
      });
    }
    for (const alias of ["full", "danger", "danger-full-access"]) {
      expect(await executeWebCommand("permission", alias, context)).toMatchObject({
        detail: "danger-full-access",
        tone: "success",
      });
    }

    expect(selected).toEqual([
      "read-only",
      "read-only",
      "read-only",
      "workspace-write",
      "workspace-write",
      "workspace-write",
      "danger-full-access",
      "danger-full-access",
      "danger-full-access",
    ]);
  });

  test("persists an active session permission before updating browser state", async () => {
    const events: string[] = [];
    const { api, requests } = createMockApi((request) => {
      events.push("api");
      return jsonResponse(session({ permissionMode: "danger-full-access" }));
    });
    const result = await executeWebCommand(
      "permission",
      "full",
      executionContext({
        api,
        onPermissionModeChange: (mode) => events.push(`mode:${mode}`),
        onSessionUpdated: () => events.push("updated"),
      }),
    );

    expect(requests).toEqual([{
      path: "/sessions/session-1",
      method: "PATCH",
      body: { permissionMode: "danger-full-access" },
    }]);
    expect(events).toEqual(["api", "mode:danger-full-access"]);
    expect(result.tone).toBe("success");
  });

  test("rejects unknown permission values and elevated access in Plan mode", async () => {
    const { api, requests } = createMockApi(() => {
      throw new Error("Rejected permission changes must not reach the API.");
    });
    const invalid = await executeWebCommand(
      "permission",
      "bananas",
      executionContext({ api }),
    );
    const planWrite = await executeWebCommand(
      "permission",
      "write",
      executionContext({ api, mode: "plan", permissionMode: "read-only" }),
    );

    expect(invalid).toMatchObject({
      title: "Invalid permission mode",
      tone: "error",
    });
    expect(planWrite).toEqual({
      title: "Plan mode is read-only",
      detail: "Switch Agent mode to Build before enabling write or full access.",
      tone: "error",
    });
    expect(requests).toEqual([]);
  });

  test("formats the complete provider-facing context budget", async () => {
    const { api, requests } = createMockApi(() => jsonResponse({
      estimate: { tokens: 16_384, basis: "provider-turn-assembler" },
      contextWindow: 40_000,
      breakdown: {
        systemTokens: 1_200,
        toolTokens: 500,
        messageTokens: 14_000,
        mediaTokens: 684,
        inputTokens: 16_384,
        inputBudgetTokens: 32_768,
        messageBudgetTokens: 30_384,
        reservedOutputTokens: 8_000,
        contextWindow: 40_000,
        remainingTokens: 16_384,
        compactedTokens: 9_600,
      },
      withinBudget: true,
    }));

    const result = await executeWebCommand(
      "context",
      "",
      executionContext({ api }),
    );

    expect(requests).toEqual([
      { path: "/sessions/session-1/context", method: "GET", body: null },
    ]);
    expect(result).toEqual({
      title: "Context is within budget",
      detail: [
        "16k / 33k input tokens",
        "Prompt 1.2k · tools 500 · messages 14k · attachments 684",
        "Output reserve 8.0k · remaining 16k · compaction saved 9.6k",
      ].join("\n"),
      tone: "info",
    });
  });

  test("refreshes persisted messages and session state after undo", async () => {
    const events: string[] = [];
    const { api, requests } = createMockApi((request) => {
      events.push("api");
      return jsonResponse({
        turnKey: "turn-3",
        restoredFiles: ["apps/web/src/app.tsx", "apps/web/src/styles.css"],
        messageCount: 14,
        revision: 4,
      });
    });

    const result = await executeWebCommand(
      "undo",
      "",
      executionContext({
        api,
        refreshMessages: async () => { events.push("refresh"); },
        onSessionUpdated: () => events.push("updated"),
      }),
    );

    expect(requests).toEqual([
      { path: "/sessions/session-1/undo", method: "POST", body: {} },
    ]);
    expect(events).toEqual(["api", "refresh", "updated"]);
    expect(result).toEqual({
      title: "Undo complete",
      detail: "2 files restored · 14 messages",
      tone: "success",
    });
  });

  test("switches models within the selected provider and publishes new status", async () => {
    const updates: ProviderStatus[] = [];
    const { api, requests } = createMockApi((request) => {
      expect(request.body).toEqual({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
      });
      return jsonResponse({
        ok: true,
        configStatus: providerStatus({
          selectedModel: "anthropic/claude-sonnet-4.5",
        }),
      });
    });

    const result = await executeWebCommand(
      "model",
      "  anthropic/claude-sonnet-4.5  ",
      executionContext({
        api,
        onProviderStatusChange: (status) => updates.push(status),
      }),
    );

    expect(requests).toEqual([
      {
        path: "/config/model",
        method: "PUT",
        body: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
        },
      },
    ]);
    expect(updates.map(({ selectedModel }) => selectedModel)).toEqual([
      "anthropic/claude-sonnet-4.5",
    ]);
    expect(result).toEqual({
      title: "Model changed",
      detail: "openrouter · anthropic/claude-sonnet-4.5",
      tone: "success",
    });
  });

  test("does not call an API for unknown commands", async () => {
    const { api, requests } = createMockApi();
    const result = await executeWebCommand(
      "teleport",
      "somewhere",
      executionContext({ api }),
    );

    expect(requests).toEqual([]);
    expect(result).toEqual({
      title: "Unknown command /teleport",
      detail: "Type / to see every available command.",
      tone: "error",
    });
  });

  test("rejects arguments for commands that do not accept them", async () => {
    const { api, requests } = createMockApi(() => {
      throw new Error("Invalid arguments must not reach the API.");
    });
    const result = await executeWebCommand(
      "status",
      "anything",
      executionContext({ api }),
    );

    expect(requests).toEqual([]);
    expect(result).toEqual({
      title: "/status does not accept arguments",
      detail: "Usage: /status",
      tone: "error",
    });
  });

  test("aborts only while a run is active", async () => {
    let aborts = 0;
    const inactive = await executeWebCommand(
      "abort",
      "",
      executionContext({ isStreaming: false }),
    );
    const active = await executeWebCommand(
      "abort",
      "",
      executionContext({
        isStreaming: true,
        abortActiveRun: async () => { aborts += 1; },
      }),
    );

    expect(inactive.tone).toBe("error");
    expect(active).toMatchObject({ title: "Run aborted", tone: "success" });
    expect(aborts).toBe(1);
  });

  test("uses browser adapters for copy and Markdown export", async () => {
    const copied: string[] = [];
    const downloads: Array<{ filename: string; text: string }> = [];
    const { api } = createMockApi(() => jsonResponse({
      exportedAt: "2026-08-20T10:00:00.000Z",
      session: session({ title: "Command Test" }),
      messages: [{
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Answer" }, { type: "tool-test", input: { path: "a" }, output: { ok: true } }],
      }],
    }));
    const messages = [{
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Use this:\n```ts\nconst ok = true;\n```" }],
    }] as UIMessage[];
    const context = executionContext({
      api,
      messages,
      copyText: async (text) => { copied.push(text); },
      downloadText: (filename, text) => downloads.push({ filename, text }),
    });

    expect((await executeWebCommand("copy", "code", context)).tone).toBe("success");
    expect((await executeWebCommand("export", "", context)).tone).toBe("success");
    expect(copied).toEqual(["const ok = true;"]);
    expect(downloads[0]?.filename).toBe("command-test.md");
    expect(downloads[0]?.text).toContain("permission-mode: workspace-write");
    expect(downloads[0]?.text).toContain("**Tool · test**");
  });

  test("shows focused help for a command", async () => {
    const result = await executeWebCommand("help", "ctx", executionContext());
    expect(result.title).toBe("/context");
    expect(result.detail).toContain("provider request budget");
  });

  test("turns API errors into a command-scoped result", async () => {
    const { api } = createMockApi(() =>
      jsonResponse({ error: "Context service unavailable." }, 503),
    );

    const result = await executeWebCommand(
      "context",
      "",
      executionContext({ api }),
    );

    expect(result).toEqual({
      title: "/context failed",
      detail: "Context service unavailable.",
      tone: "error",
    });
  });

  test("guards every server command that requires an active session", async () => {
    const { api, requests } = createMockApi(() => {
      throw new Error("A guarded command must not reach the API.");
    });
    const context = executionContext({ api, sessionId: undefined });

    for (const command of [
      "compact",
      "context",
      "undo",
      "redo",
      "export",
      "skills",
    ]) {
      const result = await executeWebCommand(command, "", context);
      expect(result).toEqual({
        title: `/${command} needs a session`,
        detail: "Start or open a session, then run the command again.",
        tone: "error",
      });
    }

    expect(requests).toEqual([]);
  });
});
