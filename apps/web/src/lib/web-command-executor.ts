import type { UIMessage } from "ai";
import type {
  LightcodeApi,
  CodingMode,
  PermissionMode,
  ProviderStatus,
  Session,
  SessionExport,
} from "./api";
import {
  findSlashCommand,
  formatSlashCommandUsage,
  slashCommandRegistry,
} from "./slash-command-registry";

export type CommandResultTone = "info" | "success" | "error";

export interface CommandResult {
  title: string;
  detail: string;
  tone: CommandResultTone;
}

export interface WebCommandExecutionContext {
  api: LightcodeApi;
  sessionId?: string;
  messages: readonly UIMessage[];
  sessions: readonly Session[];
  mode: CodingMode;
  permissionMode: PermissionMode;
  providerStatus: ProviderStatus | null;
  isStreaming: boolean;
  abortActiveRun?: () => Promise<void>;
  refreshMessages?: () => Promise<void>;
  onSessionUpdated?: () => void;
  onNewSession: () => void;
  onOpenSessions: () => void;
  onSelectSession: (session: Session) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onProviderStatusChange: (status: ProviderStatus) => void;
  copyText?: (text: string) => Promise<void>;
  downloadText?: (filename: string, text: string) => void;
}

function result(
  title: string,
  detail: string,
  tone: CommandResultTone = "info",
): CommandResult {
  return { title, detail, tone };
}

function errorResult(title: string, detail: string): CommandResult {
  return result(title, detail, "error");
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function latestAssistantText(messages: readonly UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return null;
}

function codeBlocks(value: string): string[] {
  return Array.from(value.matchAll(/```[^\n]*\n([\s\S]*?)```/g), (match) =>
    (match[1] ?? "").replace(/\n$/, ""),
  ).filter(Boolean);
}

function transcript(messages: readonly UIMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = messageText(message);
      if (!text) return null;
      return `## ${message.role === "user" ? "You" : "Lightcode"}\n\n${text}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n\n");
}

function exportMarkdown(payload: SessionExport): string {
  function jsonBlock(label: string, value: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(value, null, 2);
    } catch {
      serialized = String(value);
    }
    return `\`\`\`${label}\n${serialized}\n\`\`\``;
  }

  function partMarkdown(part: unknown): string | null {
    if (!part || typeof part !== "object") return null;
    const type = Reflect.get(part, "type");
    if (typeof type !== "string") return null;
    if (type === "text") {
      const text = Reflect.get(part, "text");
      return typeof text === "string" ? text : null;
    }
    if (type === "reasoning") {
      const text = Reflect.get(part, "text") ?? Reflect.get(part, "reasoning");
      return typeof text === "string" ? `<details>\n<summary>Reasoning</summary>\n\n${text}\n\n</details>` : null;
    }
    if (type === "source-url") {
      const url = Reflect.get(part, "url");
      const title = Reflect.get(part, "title");
      return typeof url === "string" ? `[${typeof title === "string" ? title : url}](${url})` : null;
    }
    if (type === "source-document") {
      const title = Reflect.get(part, "title");
      return typeof title === "string" ? `[Source document: ${title}]` : null;
    }
    if (type === "file" || type === "image") {
      const filename = Reflect.get(part, "filename") ?? Reflect.get(part, "fileName") ?? Reflect.get(part, "mediaType");
      return `[${type === "image" ? "Image" : "File"}: ${typeof filename === "string" ? filename : "attachment"}]`;
    }
    if (type === "tool-call") {
      return `${jsonBlock("tool", Reflect.get(part, "toolName") ?? "unknown")}\n${jsonBlock("json", Reflect.get(part, "args") ?? {})}`;
    }
    if (type === "tool-result") {
      return jsonBlock("tool-result", Reflect.get(part, "result"));
    }
    if (type.startsWith("tool-") || type === "dynamic-tool") {
      const toolName = type === "dynamic-tool" ? Reflect.get(part, "toolName") : type.slice(5);
      const input = Reflect.get(part, "input");
      const output = Reflect.get(part, "output") ?? Reflect.get(part, "errorText");
      return [
        `**Tool · ${typeof toolName === "string" ? toolName : "unknown"}**`,
        input === undefined ? null : jsonBlock("json", input),
        output === undefined ? null : jsonBlock("result", output),
      ].filter((value): value is string => value !== null).join("\n\n");
    }
    if (type === "citation") {
      return jsonBlock("citation", Reflect.get(part, "citation") ?? part);
    }
    return null;
  }

  const messages = payload.messages.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const role = Reflect.get(raw, "role");
    const parts = Reflect.get(raw, "parts");
    if ((role !== "user" && role !== "assistant") || !Array.isArray(parts)) return [];
    const text = parts
      .map(partMarkdown)
      .filter((value): value is string => value !== null)
      .join("\n")
      .trim();
    return text ? [`## ${role === "user" ? "You" : "Lightcode"}\n\n${text}`] : [];
  });
  const title = payload.session.title?.trim() || "Lightcode session";
  const frontMatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `date: ${JSON.stringify(payload.session.createdAt)}`,
    `exported: ${JSON.stringify(payload.exportedAt)}`,
    `mode: ${payload.session.mode}`,
    payload.session.permissionMode ? `permission-mode: ${payload.session.permissionMode}` : null,
    payload.session.model ? `model: ${JSON.stringify(payload.session.model)}` : null,
    payload.session.cwd ? `cwd: ${JSON.stringify(payload.session.cwd)}` : null,
    `session-id: ${payload.session.id}`,
    "---",
  ].filter((line): line is string => line !== null).join("\n");
  return `${frontMatter}\n\n${messages.join("\n\n---\n\n")}\n`;
}

function defaultDownload(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportFilename(session: SessionExport["session"]): string {
  const base = (session.title?.trim() || `lightcode-session-${session.id.slice(0, 8)}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "lightcode-session"}.md`;
}

function parsePermissionMode(value: string): PermissionMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "read" || normalized === "readonly" || normalized === "read-only") {
    return "read-only";
  }
  if (normalized === "write" || normalized === "workspace" || normalized === "workspace-write") {
    return "workspace-write";
  }
  if (normalized === "full" || normalized === "danger" || normalized === "danger-full-access") {
    return "danger-full-access";
  }
  return null;
}

function requireSession(context: WebCommandExecutionContext, command: string): string | CommandResult {
  return context.sessionId ?? errorResult(
    `/${command} needs a session`,
    "Start or open a session, then run the command again.",
  );
}

async function copyCommand(
  args: string,
  context: WebCommandExecutionContext,
): Promise<CommandResult> {
  const scope = args.trim().toLowerCase() || "last";
  let content: string | null = null;
  let label = "last reply";
  if (scope === "all") {
    content = transcript(context.messages) || null;
    label = "conversation";
  } else if (scope === "code") {
    const blocks = codeBlocks(latestAssistantText(context.messages) ?? "");
    content = blocks.length ? blocks.join("\n\n") : null;
    label = blocks.length === 1 ? "code block" : "code blocks";
  } else if (scope === "last") {
    content = latestAssistantText(context.messages);
  } else {
    return errorResult("Copy command", "Usage: /copy [last|code|all]");
  }
  if (!content) {
    return errorResult("Nothing to copy", scope === "code" ? "No code blocks were found in the last reply." : "There is no assistant reply yet.");
  }
  try {
    await (context.copyText ?? ((text) => navigator.clipboard.writeText(text)))(content);
    return result("Copied", `${label} · ${content.length.toLocaleString()} characters`, "success");
  } catch {
    return errorResult("Copy failed", "Clipboard access is unavailable in this browser tab.");
  }
}

export async function executeWebCommand(
  command: string,
  args: string,
  context: WebCommandExecutionContext,
): Promise<CommandResult> {
  try {
    const definition = slashCommandRegistry.find((candidate) => candidate.id === command);
    if (!definition) {
      return errorResult(`Unknown command /${command}`, "Type / to see every available command.");
    }
    if (args.trim() && !definition.argumentHint) {
      return errorResult(
        `/${command} does not accept arguments`,
        `Usage: ${definition.command}`,
      );
    }
    const commandId = definition.id;
    switch (commandId) {
      case "help":
        if (args.trim()) {
          const helpCommand = findSlashCommand(args.trim());
          return helpCommand
            ? result(
                formatSlashCommandUsage(helpCommand),
                `${helpCommand.description}\nAliases: ${helpCommand.aliases.length ? helpCommand.aliases.join(", ") : "none"}`,
              )
            : errorResult("Command not found", `No slash command matches ${args.trim()}.`);
        }
        return result(
          `${slashCommandRegistry.length} slash commands`,
          `${slashCommandRegistry.map((item) => item.command).join(" · ")}\n\nType / to browse. Use ↑/↓ to move, Tab to complete, Enter to run, and Esc to close.`,
        );
      case "home":
        context.onNewSession();
        return result("New session", "Ready for a new conversation.", "success");
      case "sessions":
        context.onOpenSessions();
        return result("Sessions", `${context.sessions.length} saved session${context.sessions.length === 1 ? "" : "s"}.`);
      case "latest": {
        const latest = context.sessions[0];
        if (!latest) return errorResult("No saved sessions", "Start a conversation first.");
        context.onSelectSession(latest);
        return result("Latest session opened", latest.title?.trim() || latest.latestUserPromptPreview?.trim() || "Untitled session", "success");
      }
      case "permission": {
        const next = parsePermissionMode(args);
        if (!next) {
          if (args.trim()) {
            return errorResult(
              "Invalid permission mode",
              "Usage: /permission read-only | workspace-write | danger-full-access",
            );
          }
          return result(
            "Permission mode",
            context.mode === "plan"
              ? `Effective: read-only (Plan mode)\nSaved for Build: ${context.permissionMode}\nUsage: /permission read-only | workspace-write | danger-full-access`
              : `Current: ${context.permissionMode}\nUsage: /permission read-only | workspace-write | danger-full-access`,
          );
        }
        if (context.mode === "plan" && next !== "read-only") {
          return errorResult(
            "Plan mode is read-only",
            "Switch Agent mode to Build before enabling write or full access.",
          );
        }
        if (context.sessionId) {
          await context.api.updateSessionPermission(context.sessionId, next);
        }
        context.onPermissionModeChange(next);
        return result("Permission changed", next, "success");
      }
      case "copy":
        return copyCommand(args, context);
      case "abort":
        if (!context.isStreaming || !context.abortActiveRun) {
          return errorResult("No active run", "There is nothing to abort.");
        }
        await context.abortActiveRun();
        return result("Run aborted", "Model streaming and active tool work were stopped.", "success");
      case "compact": {
        const sessionId = requireSession(context, command);
        if (typeof sessionId !== "string") return sessionId;
        const compacted = await context.api.compactSession(sessionId);
        return result(
          "Context compacted",
          compacted.usedFallback ? "Used the bounded heuristic summary." : "Used an LLM-written summary.",
          "success",
        );
      }
      case "context": {
        const sessionId = requireSession(context, command);
        if (typeof sessionId !== "string") return sessionId;
        const report = await context.api.getContext(sessionId);
        const { breakdown } = report;
        return result(
          report.withinBudget ? "Context is within budget" : "Context exceeds budget",
          [
            `${formatTokens(breakdown.inputTokens)} / ${formatTokens(breakdown.inputBudgetTokens)} input tokens`,
            `Prompt ${formatTokens(breakdown.systemTokens)} · tools ${formatTokens(breakdown.toolTokens)} · messages ${formatTokens(breakdown.messageTokens)} · attachments ${formatTokens(breakdown.mediaTokens)}`,
            `Output reserve ${formatTokens(breakdown.reservedOutputTokens)} · remaining ${formatTokens(breakdown.remainingTokens)} · compaction saved ${formatTokens(breakdown.compactedTokens)}`,
          ].join("\n"),
          report.withinBudget ? "info" : "error",
        );
      }
      case "undo":
      case "redo": {
        const sessionId = requireSession(context, commandId);
        if (typeof sessionId !== "string") return sessionId;
        const changed = await context.api.changeSessionHistory(sessionId, commandId);
        await context.refreshMessages?.();
        context.onSessionUpdated?.();
        const label = commandId === "undo" ? "Undo" : "Redo";
        return result(
          `${label} complete`,
          `${changed.restoredFiles.length} file${changed.restoredFiles.length === 1 ? "" : "s"} restored · ${changed.messageCount} messages`,
          "success",
        );
      }
      case "export": {
        const sessionId = requireSession(context, command);
        if (typeof sessionId !== "string") return sessionId;
        const payload = await context.api.exportSession(sessionId);
        const filename = exportFilename(payload.session);
        (context.downloadText ?? defaultDownload)(filename, exportMarkdown(payload));
        return result("Session exported", filename, "success");
      }
      case "skills": {
        const sessionId = requireSession(context, command);
        if (typeof sessionId !== "string") return sessionId;
        const { skills } = await context.api.listSkills(sessionId);
        if (!skills.length) {
          return result("No skills found", "Add project skills under .lightcode/skills/<name>/SKILL.md.");
        }
        return result(
          `${skills.length} skill${skills.length === 1 ? "" : "s"} available`,
          skills.map((skill) => `${skill.name} · ${skill.description ?? "No description"} · ${skill.source}`).join("\n"),
        );
      }
      case "status": {
        const status = await context.api.getDiagnosticsStatus();
        const activeSession = context.sessions.find((session) => session.id === context.sessionId);
        return result(
          `Lightcode status · ${status.server.status}`,
          [
            activeSession
              ? `Session ${activeSession.title?.trim() || activeSession.id.slice(0, 8)} · ${activeSession.mode}/${context.permissionMode} · ${context.messages.length} messages\n${activeSession.pathLabel ?? activeSession.cwd ?? "Workspace unavailable"}`
              : "No active session",
            `${status.provider.provider} · ${status.provider.model} · ${status.provider.status}`,
            `Database ${status.database.status} · ${status.database.sessionCount ?? "?"} sessions · ${status.database.messageCount ?? "?"} messages`,
            `${status.tools.total} tools · web search ${status.webSearch.available ? `${status.webSearch.backend} ready` : "unavailable"}`,
            `${status.extensions.skills.count} skills · ${status.extensions.mcp.runningServers}/${status.extensions.mcp.configuredServers} MCP running · ${status.extensions.plugins.count} plugins`,
          ].join("\n"),
          status.server.status === "error" || status.provider.status === "error" ? "error" : "info",
        );
      }
      case "doctor": {
        const doctor = await context.api.runDoctor();
        return result(
          `Doctor · ${doctor.status}`,
          doctor.checks.map((check) => `${check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "×"} ${check.label}: ${check.summary}${check.details.length ? `\n  ${check.details.join("\n  ")}` : ""}`).join("\n"),
          doctor.status === "error" ? "error" : "info",
        );
      }
      case "permissions": {
        const permissions = await context.api.getDiagnosticsPermissions();
        const ruleCount = Object.values(permissions.rules).reduce((total, values) => total + (values?.length ?? 0), 0);
        return result(
          "Permissions",
          [
            context.sessionId ? `Current session ${context.permissionMode}` : "No active session",
            `Effective ${permissions.effectivePermissionMode} · default mode ${permissions.defaultMode}`,
            `${permissions.allowedTools?.length ?? "all"} allowed tools · ${ruleCount} explicit rules`,
            `Persisted approvals ${permissions.pendingApprovalsPersisted ? "enabled" : "disabled"}`,
            ...permissions.notes,
          ].join("\n"),
        );
      }
      case "tools": {
        const tools = await context.api.getDiagnosticsTools();
        return result(
          `${tools.summary.total} registered tools`,
          tools.tools.map((tool) => `${tool.name} · ${tool.permissionMode} · ${tool.activeInModes.join("/")}\n  ${tool.description}`).join("\n"),
        );
      }
      case "config":
      case "model-info": {
        const status = await context.api.getProviderStatus();
        context.onProviderStatusChange(status);
        return result(
          commandId === "config" ? "Effective configuration" : "Active model",
          [
            `${status.selectedProvider} · ${status.selectedModel}`,
            `Endpoint ${status.baseUrl ?? "provider default"}`,
            `Context ${status.contextWindow ? formatTokens(status.contextWindow) : "unknown"} · output ${status.maxOutputTokens ? formatTokens(status.maxOutputTokens) : "unknown"} · max steps ${status.maxSteps ?? "unknown"}`,
            `Permission ${status.permissionMode ?? "session default"} · web search ${status.webSearch?.available ? `${status.webSearch.backend} ready` : "unavailable"}`,
            status.missingCredentialHints.length ? `Missing: ${status.missingCredentialHints.join(", ")}` : "Credentials ready",
          ].join("\n"),
        );
      }
      case "model": {
        const status = context.providerStatus ?? await context.api.getProviderStatus();
        const model = args.trim();
        if (model) {
          const updated = await context.api.selectModel(status.selectedProvider, model);
          context.onProviderStatusChange(updated);
          return result("Model changed", `${updated.selectedProvider} · ${updated.selectedModel}`, "success");
        }
        if (status.selectedProvider !== "openrouter") {
          return result(
            "Active model",
            `${status.selectedProvider} · ${status.selectedModel}\nUse /model <model-id> to switch within this provider.`,
          );
        }
        const catalog = await context.api.listModels(status.selectedProvider);
        const suggested = catalog.models.filter((item) => item.supportsTools).slice(0, 12);
        return result(
          `OpenRouter models · ${catalog.models.length} available`,
          `${suggested.map((item) => `${item.id}${item.id === status.selectedModel ? " · current" : ""}`).join("\n")}\n\nUse /model <model-id> to switch.`,
        );
      }
      case "connect": {
        const status = await context.api.getProviderStatus();
        const detail = status.missingCredentialHints.length
          ? `Missing ${status.missingCredentialHints.join(", ")}. Provider credentials are intentionally configured in the trusted terminal flow. Run lightcode, then /connect.`
          : `${status.selectedProvider} is connected with ${status.selectedModel}. Use /model to inspect or switch models.`;
        return result("Provider setup · trusted terminal", detail, status.missingCredentialHints.length ? "error" : "success");
      }
      default: {
        const unhandledCommand: never = commandId;
        return errorResult("Command unavailable", `No web handler exists for ${unhandledCommand}.`);
      }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The command could not be completed.";
    return errorResult(`/${command} failed`, message);
  }
}
