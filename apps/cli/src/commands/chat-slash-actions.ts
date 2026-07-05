import {
  collectMessageText,
  permissionModeSchema,
  sessionCompactResponseSchema,
  sessionExportJsonSchema,
  type PermissionMode,
  type SessionContextState,
} from "@lightcode/ai";
import type { UIMessage } from "ai";
import { client } from "../lib/client";
import { extractCodeBlocks } from "../utils/markdown-code";
import {
  getExportPath,
  sessionToMarkdown,
} from "./export-session-markdown";

export type ChatActionTone = "info" | "error";

export interface ChatSlashActionContext {
  sessionId: string;
  /** Text after the command token, e.g. "all" for "/copy all". */
  args: string;
  /** Current conversation, newest last. */
  messages: UIMessage[];
  setContextState: (state: SessionContextState | null) => void;
  notify: (message: string, tone?: ChatActionTone) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  copyToClipboard: (text: string) => Promise<boolean>;
}

export interface ChatSlashActionDefinition {
  kind: "chat-action";
  id: string;
  label: string;
  description: string;
  /** Display + matching string, e.g. "/compact". */
  shortcut: string;
  /** Also offered in the home-screen slash menu, before a session exists. */
  availableOnHome?: boolean;
  run: (context: ChatSlashActionContext) => Promise<void>;
}

async function runCompactAction({
  sessionId,
  setContextState,
  notify,
}: ChatSlashActionContext): Promise<void> {
  notify("Compacting context...");

  try {
    const response = await client.sessions[":id"].compact.$post({
      param: { id: sessionId },
    });

    if (response.status === 409) {
      notify("Not enough conversation to compact yet.", "error");
      return;
    }

    if (!response.ok) {
      notify(`Compaction failed (HTTP ${response.status}).`, "error");
      return;
    }

    const parsed = sessionCompactResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      notify("Server returned an invalid compaction response.", "error");
      return;
    }

    setContextState(parsed.data.contextState);
    notify(
      parsed.data.usedFallback
        ? "Context compacted (heuristic fallback summary)."
        : "Context compacted with an LLM-written summary.",
    );
  } catch {
    notify("Compaction failed: server unreachable.", "error");
  }
}

async function runUndoAction({
  sessionId,
  notify,
}: ChatSlashActionContext): Promise<void> {
  try {
    const { undoLastTurn } = await import("@lightcode/ai/runtime");
    const result = await undoLastTurn({ sessionId });

    if (!result) {
      notify("Nothing to undo - no checkpointed file edits in this session.", "error");
      return;
    }

    notify(
      `Reverted ${result.restoredFiles.length} file${
        result.restoredFiles.length === 1 ? "" : "s"
      }: ${result.restoredFiles.join(", ")}`,
    );
  } catch (error) {
    notify(
      `Undo failed: ${error instanceof Error ? error.message : "unknown error"}`,
      "error",
    );
  }
}

async function runExportAction({
  sessionId,
  notify,
}: ChatSlashActionContext): Promise<void> {
  notify("Exporting session to markdown...");

  try {
    const response = await client.sessions[":id"].export.$get({
      param: { id: sessionId },
    });

    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }

    const rawPayload = await response.json();
    const parsedPayload = sessionExportJsonSchema.safeParse(rawPayload);

    if (!parsedPayload.success) {
      throw new Error("Server returned an invalid export response.");
    }

    const markdown = sessionToMarkdown(parsedPayload.data);
    const exportPath = getExportPath(
      parsedPayload.data.session.title,
      parsedPayload.data.session.id,
    );

    await Bun.write(exportPath, markdown);

    const displayPath = exportPath.replace(/\\/g, "/");
    notify(`Session exported to ${displayPath}`);
  } catch (error) {
    notify(
      `Export failed: ${error instanceof Error ? error.message : "unknown error"}`,
      "error",
    );
  }
}

function latestAssistantText(messages: UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const text = collectMessageText(message);
      if (text.trim()) {
        return text;
      }
    }
  }
  return null;
}

function conversationTranscript(messages: UIMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = collectMessageText(message);
      if (!text.trim()) {
        return null;
      }
      const label = message.role === "user" ? "You" : "Assistant";
      return `## ${label}\n\n${text}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n\n");
}

/** /copy [last|code|all] — copy chat content to the system clipboard. */
async function runCopyAction({
  args,
  messages,
  notify,
  copyToClipboard,
}: ChatSlashActionContext): Promise<void> {
  const scope = args.trim().toLowerCase() || "last";

  let payload: string | null = null;
  let label: string;

  if (scope === "all") {
    const transcript = conversationTranscript(messages);
    payload = transcript.trim() ? transcript : null;
    label = "conversation";
  } else if (scope === "code") {
    const lastText = latestAssistantText(messages);
    const blocks = lastText ? extractCodeBlocks(lastText) : [];
    payload = blocks.length > 0 ? blocks.map((block) => block.code).join("\n\n") : null;
    label = blocks.length === 1 ? "code block" : "code blocks";
  } else if (scope === "last") {
    payload = latestAssistantText(messages);
    label = "last reply";
  } else {
    notify("Usage: /copy [last|code|all]", "error");
    return;
  }

  if (!payload) {
    notify(
      scope === "code"
        ? "No code blocks found in the last reply."
        : "Nothing to copy yet.",
      "error",
    );
    return;
  }

  const copied = await copyToClipboard(payload);
  notify(
    copied
      ? `Copied ${label} to clipboard (${payload.length} chars).`
      : "Copy failed: clipboard unavailable in this terminal.",
    copied ? "info" : "error",
  );
}

/** /skills — list the skills the coding agent can load in this workspace. */
async function runSkillsAction({
  notify,
}: ChatSlashActionContext): Promise<void> {
  try {
    const { listSkills } = await import("@lightcode/ai/runtime");
    const skills = listSkills({ cwd: process.cwd() });

    if (skills.length === 0) {
      notify(
        "No skills found. Add one at .lightcode/skills/<name>/SKILL.md (or ~/.lightcode/skills/ for all projects).",
      );
      return;
    }

    const lines = skills.map(
      (skill) =>
        `• ${skill.name}${skill.description ? ` — ${skill.description}` : ""} (${skill.source})`,
    );
    notify(
      `Available skills (ask the agent to use one by name):\n${lines.join("\n")}`,
    );
  } catch (error) {
    notify(
      `Could not list skills: ${error instanceof Error ? error.message : "unknown error"}`,
      "error",
    );
  }
}

export const chatSlashActions: ChatSlashActionDefinition[] = [
  {
    kind: "chat-action",
    id: "copy",
    label: "Copy",
    description: "Copy chat content to the clipboard: /copy [last|code|all]",
    shortcut: "/copy",
    run: runCopyAction,
  },
  {
    kind: "chat-action",
    id: "export",
    label: "Export session",
    description: "Save the current chat session as a clean markdown file",
    shortcut: "/export",
    run: runExportAction,
  },
  {
    kind: "chat-action",
    id: "compact",
    label: "Compact context",
    description: "Summarize older messages to free context window space",
    shortcut: "/compact",
    run: runCompactAction,
  },
  {
    kind: "chat-action",
    id: "undo",
    label: "Undo last turn",
    description: "Revert file edits made by the most recent agent turn",
    shortcut: "/undo",
    run: runUndoAction,
  },
  {
    kind: "chat-action",
    id: "skills",
    label: "List skills",
    description: "Show the skills the agent can load in this workspace",
    shortcut: "/skills",
    run: runSkillsAction,
  },
  {
    kind: "chat-action",
    id: "permission",
    label: "Permission mode",
    description: "Switch permission level: read-only, workspace-write, or danger-full-access",
    shortcut: "/permission",
    availableOnHome: true,
    // This action is handled specially by the hosting screen to open the selector
    run: async () => {
      // Placeholder - actual handling happens via requestedChatActionId
    },
  },
];

export function findChatSlashAction(
  text: string,
): ChatSlashActionDefinition | null {
  // Match on the command token only so actions can take arguments
  // (e.g. "/copy all" still resolves to the "/copy" action).
  const command = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return (
    chatSlashActions.find((action) => action.shortcut === command) ?? null
  );
}

/** Returns the text after the command token, e.g. "all" for "/copy all". */
export function parseChatSlashArgs(text: string): string {
  const trimmed = text.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
}

export function getChatSlashActionById(
  id: string,
): ChatSlashActionDefinition | null {
  return chatSlashActions.find((action) => action.id === id) ?? null;
}

export function filterChatSlashActions(
  query: string,
): ChatSlashActionDefinition[] {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  if (!normalized) {
    return chatSlashActions;
  }

  // Match on the command name and label only; matching descriptions keeps
  // unrelated entries around and makes the menu feel like it never filters.
  return chatSlashActions.filter(
    (action) =>
      action.shortcut.replace(/^\//, "").toLowerCase().startsWith(normalized) ||
      action.label.toLowerCase().includes(normalized),
  );
}
