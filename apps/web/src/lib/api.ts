import { z } from "zod";

export const webTokenStorageKey = "lightcode.web.launch-token";
export const selectedWorkspaceStorageKey = "lightcode.web.workspace";

const nonEmptyBoundedString = z.string().min(1).max(4096);

export const codingModeSchema = z.enum(["build", "plan"]);
export type CodingMode = z.infer<typeof codingModeSchema>;

export const permissionModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const sessionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().nullable(),
    cwd: z.string().nullable(),
    pathLabel: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    mode: codingModeSchema,
    permissionMode: permissionModeSchema.nullable(),
    model: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative().optional(),
    latestUserPromptPreview: z.string().nullable().optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();
export type Session = z.infer<typeof sessionSchema>;

const sessionPermissionUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  permissionMode: permissionModeSchema.nullable(),
});
export type SessionPermissionUpdate = z.infer<typeof sessionPermissionUpdateSchema>;

export const sessionListSchema = z.object({
  sessions: z.array(sessionSchema),
});

export const sessionMessagesSchema = z.object({
  session: sessionSchema.optional(),
  messages: z.array(z.json()),
  contextState: z.unknown().nullable().optional(),
});
export type SessionMessages = z.infer<typeof sessionMessagesSchema>;

const providerStatusSchema = z.object({
  selectedProvider: z.string().min(1),
  selectedModel: z.string().min(1),
  missingCredentialHints: z.array(z.string()),
  configuredModel: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  defaultMode: codingModeSchema.optional(),
  permissionMode: permissionModeSchema.nullable().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxSteps: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
  pricing: z
    .object({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
      cachedInputPerMTok: z.number().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
  webSearch: z
    .object({
      available: z.boolean(),
      backend: z.string(),
      execution: z.string(),
      reason: z.string().nullable().optional(),
    })
    .passthrough()
    .optional(),
}).passthrough();
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

const contextReportSchema = z.object({
  estimate: z.object({ tokens: z.number().nonnegative(), basis: z.string() }),
  contextWindow: z.number().int().positive(),
  breakdown: z.object({
    systemTokens: z.number().int().nonnegative(),
    toolTokens: z.number().int().nonnegative(),
    messageTokens: z.number().int().nonnegative(),
    mediaTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    inputBudgetTokens: z.number().int().nonnegative(),
    messageBudgetTokens: z.number().int().nonnegative(),
    reservedOutputTokens: z.number().int().nonnegative(),
    contextWindow: z.number().int().positive(),
    remainingTokens: z.number().int().nonnegative(),
    compactedTokens: z.number().int().nonnegative(),
  }),
  withinBudget: z.boolean(),
}).passthrough();
export type ContextReport = z.infer<typeof contextReportSchema>;

const compactResultSchema = z.object({
  contextState: z.unknown(),
  usedFallback: z.boolean(),
});

const historyActionResultSchema = z.object({
  turnKey: z.string().min(1),
  restoredFiles: z.array(z.string()),
  messageCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type HistoryActionResult = z.infer<typeof historyActionResultSchema>;

const sessionExportSchema = z.object({
  exportedAt: z.string().min(1),
  session: sessionSchema,
  messages: z.array(z.json()),
});
export type SessionExport = z.infer<typeof sessionExportSchema>;

const skillListSchema = z.object({
  skills: z.array(z.object({
    name: z.string().min(1),
    description: z.string().nullable(),
    path: z.string().min(1),
    source: z.enum(["project", "user"]),
  })),
});
export type SkillList = z.infer<typeof skillListSchema>;

const diagnosticStateSchema = z.enum(["ok", "warn", "error"]);
const diagnosticCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: diagnosticStateSchema,
  summary: z.string().min(1),
  details: z.array(z.string()).default([]),
});
const diagnosticsStatusSchema = z.object({
  server: z.object({
    status: diagnosticStateSchema,
    name: z.string(),
    uptimeSeconds: z.number().nonnegative(),
    platform: z.string(),
    bunVersion: z.string().nullable(),
  }),
  provider: z.object({
    status: diagnosticStateSchema,
    provider: z.string(),
    model: z.string(),
    missingCredentialHints: z.array(z.string()),
  }).passthrough(),
  database: z.object({
    status: diagnosticStateSchema,
    reachable: z.boolean(),
    sessionCount: z.number().int().nonnegative().nullable(),
    messageCount: z.number().int().nonnegative().nullable(),
    error: z.string().nullable(),
  }),
  tools: z.object({
    total: z.number().int().nonnegative(),
    readOnly: z.number().int().nonnegative(),
    workspaceWrite: z.number().int().nonnegative(),
    dangerFullAccess: z.number().int().nonnegative(),
  }).passthrough(),
  webSearch: z.object({
    available: z.boolean(),
    backend: z.string(),
    execution: z.string(),
    reason: z.string().nullable().optional(),
  }).passthrough(),
  extensions: z.object({
    skills: z.object({ count: z.number().int().nonnegative() }),
    mcp: z.object({
      configuredServers: z.number().int().nonnegative(),
      runningServers: z.number().int().nonnegative(),
      degradedServers: z.number().int().nonnegative(),
    }).passthrough(),
    plugins: z.object({ count: z.number().int().nonnegative() }).passthrough(),
  }),
}).passthrough();
export type DiagnosticsStatus = z.infer<typeof diagnosticsStatusSchema>;

const diagnosticsDoctorSchema = z.object({
  status: diagnosticStateSchema,
  checks: z.array(diagnosticCheckSchema),
}).passthrough();
export type DiagnosticsDoctor = z.infer<typeof diagnosticsDoctorSchema>;

const diagnosticsPermissionsSchema = z.object({
  defaultMode: codingModeSchema,
  effectivePermissionMode: permissionModeSchema,
  configuredPermissionMode: permissionModeSchema.nullable(),
  allowedTools: z.array(z.string()).nullable(),
  rules: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    deniedTools: z.array(z.string()).optional(),
  }),
  sandbox: z.object({}).passthrough(),
  pendingApprovalsPersisted: z.boolean(),
  notes: z.array(z.string()),
}).passthrough();
export type DiagnosticsPermissions = z.infer<typeof diagnosticsPermissionsSchema>;

const diagnosticsToolsSchema = z.object({
  summary: z.object({
    total: z.number().int().nonnegative(),
    readOnly: z.number().int().nonnegative(),
    workspaceWrite: z.number().int().nonnegative(),
    dangerFullAccess: z.number().int().nonnegative(),
  }).passthrough(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    permissionMode: permissionModeSchema,
    activeInModes: z.array(codingModeSchema),
    availability: z.string(),
  }).passthrough()),
}).passthrough();
export type DiagnosticsTools = z.infer<typeof diagnosticsToolsSchema>;

const modelListSchema = z.object({
  provider: z.string(),
  fromCache: z.boolean(),
  models: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    contextLength: z.number().int().positive().nullable(),
    maxCompletionTokens: z.number().int().positive().nullable(),
    supportsTools: z.boolean(),
    supportsReasoning: z.boolean(),
  }).passthrough()),
}).passthrough();
export type ModelList = z.infer<typeof modelListSchema>;

export const workspaceLocationSchema = z
  .object({
    id: nonEmptyBoundedString,
    name: z.string().min(1).max(240).optional(),
    label: z.string().min(1).max(240).optional(),
    pathLabel: z.string().min(1).max(4096).optional(),
    kind: z.string().max(80).optional(),
  })
  .passthrough();
export type WorkspaceLocation = z.infer<typeof workspaceLocationSchema>;

const workspaceLocationsEnvelopeSchema = z.union([
  z.object({ locations: z.array(workspaceLocationSchema) }),
  z.array(workspaceLocationSchema).transform((locations) => ({ locations })),
]);

const browserOpenSchema = z
  .object({
    browserId: nonEmptyBoundedString,
    pathLabel: z.string().min(1).max(4096).optional(),
    location: workspaceLocationSchema.optional(),
  })
  .passthrough();

const rawBrowserEntrySchema = z
  .object({
    name: z.string().min(1).max(1024),
    kind: z.enum(["file", "directory", "symlink", "other"]),
    size: z.number().int().nonnegative().nullable(),
    readable: z.boolean(),
    symlinkState: z.enum(["internal", "external", "broken"]).nullable(),
  })
  .passthrough();

const browserEntriesSchema = z
  .object({
    entries: z.array(rawBrowserEntrySchema),
    segments: z.array(z.string().min(1).max(1024)).optional(),
    pathLabel: z.string().min(1).max(4096).optional(),
    nextCursor: z.string().nullable().optional(),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();

export interface BrowserEntry {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
  isHidden: boolean;
  isSymlink: boolean;
  selectable: boolean;
  note: string | null;
}

export interface BrowserPage {
  entries: BrowserEntry[];
  segments: string[];
  pathLabel?: string;
  nextCursor: string | null;
}

export const workspaceSchema = z
  .object({
    id: nonEmptyBoundedString,
    name: z.string().min(1).max(240),
    pathLabel: z.string().min(1).max(4096),
    createdAt: z.string().min(1),
  })
  .passthrough();
export type Workspace = z.infer<typeof workspaceSchema>;

const workspaceSelectSchema = z.object({ workspace: workspaceSchema });
const sessionReferenceSchema = z.object({ id: z.string().min(1) });
export type SessionReference = z.infer<typeof sessionReferenceSchema>;

const interactionSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    toolCallId: z.string().min(1),
    kind: z.enum(["tool_approval", "user_prompt"]),
    status: z.enum(["pending", "approved", "denied", "answered", "superseded"]),
    payload: z.json(),
    response: z.json().nullable(),
    resolvedAt: z.string().nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

const interactionListSchema = z.object({
  interactions: z.array(interactionSchema),
});
export type InteractionList = z.infer<typeof interactionListSchema>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function extractLaunchToken(fragment: string): string | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!raw) {
    return null;
  }

  const params = new URLSearchParams(raw);
  const candidate = params.get("token") ?? params.get("access_token");
  if (candidate && candidate.length <= 4096) {
    return candidate;
  }

  if (!raw.includes("=") && raw.length <= 4096) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  return null;
}

export function readLaunchToken({
  fragment,
  storage,
}: {
  fragment: string;
  storage: StorageLike;
}): { token: string | null; fromFragment: boolean } {
  const fragmentToken = extractLaunchToken(fragment);
  if (fragmentToken) {
    storage.setItem(webTokenStorageKey, fragmentToken);
    return { token: fragmentToken, fromFragment: true };
  }

  return {
    token: storage.getItem(webTokenStorageKey),
    fromFragment: false,
  };
}

export function withBearerToken(
  token: string,
  headers?: HeadersInit,
): Headers {
  const next = new Headers(headers);
  next.set("Authorization", `Bearer ${token}`);
  next.set("X-Lightcode-Client", "web");
  return next;
}

export type AuthenticatedFetch = typeof globalThis.fetch;

export function createAuthenticatedFetch(token: string): AuthenticatedFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      typeof input === "string"
        ? new URL(input, window.location.origin)
        : input instanceof URL
          ? new URL(input.toString(), window.location.origin)
          : new URL(input.url, window.location.origin);

    if (requestUrl.origin !== window.location.origin) {
      throw new Error("Lightcode web requests must remain on this local origin.");
    }

    const inheritedHeaders = input instanceof Request ? input.headers : undefined;
    const combinedHeaders = new Headers(inheritedHeaders);
    const explicitHeaders = new Headers(init?.headers);
    explicitHeaders.forEach((value, key) => combinedHeaders.set(key, value));
    const headers = withBearerToken(token, combinedHeaders);

    return globalThis.fetch(input, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  }) as AuthenticatedFetch;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Lightcode returned an invalid response (${response.status}).`);
  }
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const value = Reflect.get(payload, "error") ?? Reflect.get(payload, "message");
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  if (status === 401) {
    return "This browser launch is not authorized. Run lightcode web again.";
  }

  if (status === 403) {
    return "Lightcode refused access to this resource.";
  }

  return `Lightcode request failed with HTTP ${status}.`;
}

export class LightcodeApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "LightcodeApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function createLightcodeApi(fetcher: AuthenticatedFetch) {
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetcher(path, { ...init, headers });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new LightcodeApiError(
        errorMessage(payload, response.status),
        response.status,
        payload,
      );
    }
    return payload;
  }

  return {
    fetch: fetcher,

    async listLocations(): Promise<WorkspaceLocation[]> {
      const payload = await request("/workspaces/locations");
      return workspaceLocationsEnvelopeSchema.parse(payload).locations;
    },

    async openLocation(locationId: string) {
      return browserOpenSchema.parse(
        await request("/workspaces/browser/open", {
          method: "POST",
          body: JSON.stringify({ locationId }),
        }),
      );
    },

    async listEntries({
      browserId,
      segments,
      cursor,
      includeHidden = false,
    }: {
      browserId: string;
      segments: string[];
      cursor?: string;
      includeHidden?: boolean;
    }): Promise<BrowserPage> {
      const payload = browserEntriesSchema.parse(
        await request(`/workspaces/browser/${encodeURIComponent(browserId)}/entries`, {
          method: "POST",
          body: JSON.stringify({
            segments,
            ...(cursor ? { cursor } : {}),
            limit: 100,
            includeHidden,
          }),
        }),
      );

      return {
        entries: payload.entries.map((entry) => {
          const isDirectory = entry.kind === "directory";
          const note = !entry.readable
            ? "not readable"
            : entry.kind === "symlink"
              ? entry.symlinkState === "internal"
                ? "linked folder"
                : entry.symlinkState === "external"
                  ? "outside this location"
                  : "broken link"
              : entry.kind === "file"
                ? "file"
                : entry.kind === "other"
                  ? "unsupported"
                  : null;
          return {
            name: entry.name,
            kind: entry.kind,
            isHidden: entry.name.startsWith("."),
            isSymlink: entry.kind === "symlink",
            selectable: isDirectory && entry.readable,
            note,
          };
        }),
        segments: payload.segments ?? segments,
        pathLabel: payload.pathLabel,
        nextCursor: payload.nextCursor ?? payload.cursor ?? null,
      };
    },

    async selectWorkspace(browserId: string, segments: string[]) {
      const payload = workspaceSelectSchema.parse(
        await request(`/workspaces/browser/${encodeURIComponent(browserId)}/select`, {
          method: "POST",
          body: JSON.stringify({ segments }),
        }),
      );
      return payload.workspace;
    },

    async listSessions(): Promise<Session[]> {
      return sessionListSchema.parse(await request("/sessions")).sessions;
    },

    async getProviderStatus(): Promise<ProviderStatus> {
      return providerStatusSchema.parse(await request("/config/status"));
    },

    async getContext(sessionId: string): Promise<ContextReport> {
      return contextReportSchema.parse(
        await request(`/sessions/${encodeURIComponent(sessionId)}/context`),
      );
    },

    async compactSession(sessionId: string) {
      return compactResultSchema.parse(
        await request(`/sessions/${encodeURIComponent(sessionId)}/compact`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    },

    async changeSessionHistory(sessionId: string, action: "undo" | "redo") {
      return historyActionResultSchema.parse(
        await request(`/sessions/${encodeURIComponent(sessionId)}/${action}`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      );
    },

    async exportSession(sessionId: string): Promise<SessionExport> {
      return sessionExportSchema.parse(
        await request(`/sessions/${encodeURIComponent(sessionId)}/export`),
      );
    },

    async listSkills(sessionId: string): Promise<SkillList> {
      return skillListSchema.parse(
        await request(`/extensions/skills?sessionId=${encodeURIComponent(sessionId)}`),
      );
    },

    async getDiagnosticsStatus(): Promise<DiagnosticsStatus> {
      return diagnosticsStatusSchema.parse(await request("/diagnostics/status"));
    },

    async runDoctor(): Promise<DiagnosticsDoctor> {
      return diagnosticsDoctorSchema.parse(await request("/diagnostics/doctor"));
    },

    async getDiagnosticsPermissions(): Promise<DiagnosticsPermissions> {
      return diagnosticsPermissionsSchema.parse(
        await request("/diagnostics/permissions"),
      );
    },

    async getDiagnosticsTools(): Promise<DiagnosticsTools> {
      return diagnosticsToolsSchema.parse(await request("/diagnostics/tools"));
    },

    async listModels(provider: string): Promise<ModelList> {
      return modelListSchema.parse(
        await request(`/config/models?provider=${encodeURIComponent(provider)}`),
      );
    },

    async selectModel(provider: string, model: string): Promise<ProviderStatus> {
      const payload = z.object({
        ok: z.literal(true),
        configStatus: providerStatusSchema,
      }).passthrough().parse(
        await request("/config/model", {
          method: "PUT",
          body: JSON.stringify({ provider, model }),
        }),
      );
      return payload.configStatus;
    },

    async createSession({
      workspaceId,
      mode,
      permissionMode,
      title,
    }: {
      workspaceId: string;
      mode: CodingMode;
      permissionMode: PermissionMode;
      title?: string;
    }): Promise<SessionReference> {
      return sessionReferenceSchema.parse(
        await request(`/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
          method: "POST",
          body: JSON.stringify({ mode, permissionMode, ...(title ? { title } : {}) }),
        }),
      );
    },

    async loadSession(sessionId: string): Promise<SessionMessages> {
      return sessionMessagesSchema.parse(
        await request(`/sessions/${encodeURIComponent(sessionId)}/messages`),
      );
    },

    async updateSessionPermission(
      sessionId: string,
      permissionMode: PermissionMode,
    ): Promise<SessionPermissionUpdate> {
      return sessionPermissionUpdateSchema.parse(
        await request(`/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          body: JSON.stringify({ permissionMode }),
        }),
      );
    },

    async listPendingInteractions(sessionId: string): Promise<InteractionList> {
      return interactionListSchema.parse(
        await request(
          `/sessions/${encodeURIComponent(sessionId)}/interactions?status=pending`,
        ),
      );
    },

    async checkpointInteraction(sessionId: string, body: unknown): Promise<void> {
      await request(`/sessions/${encodeURIComponent(sessionId)}/interactions`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async resolveInteraction(
      sessionId: string,
      toolCallId: string,
      body: unknown,
    ): Promise<void> {
      await request(
        `/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(toolCallId)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
    },
  };
}

export type LightcodeApi = ReturnType<typeof createLightcodeApi>;

export function loadStoredWorkspace(storage: StorageLike): Workspace | null {
  const value = storage.getItem(selectedWorkspaceStorageKey);
  if (!value) {
    return null;
  }

  try {
    return workspaceSchema.parse(JSON.parse(value));
  } catch {
    storage.removeItem(selectedWorkspaceStorageKey);
    return null;
  }
}

export function storeWorkspace(storage: StorageLike, workspace: Workspace): void {
  storage.setItem(selectedWorkspaceStorageKey, JSON.stringify(workspace));
}

export function requiresBroadWorkspaceConfirmation(segments: readonly string[]): boolean {
  return segments.length === 0;
}

export function displaySessionTitle(session: Session): string {
  return (
    session.title?.trim() ||
    session.latestUserPromptPreview?.trim() ||
    "Untitled session"
  );
}

export function formatRelativeTime(value?: string, now = Date.now()): string {
  if (!value) {
    return "saved";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "saved";
  }

  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
