import {
  permissionModeSchema,
  sessionCompactResponseSchema,
  sessionExportJsonSchema,
  type PermissionMode,
  type SessionContextState,
} from "@lightcode/ai";
import { client } from "../lib/client";
import {
  getExportPath,
  sessionToMarkdown,
} from "./export-session-markdown";

export type ChatActionTone = "info" | "error";

export interface ChatSlashActionContext {
  sessionId: string;
  setContextState: (state: SessionContextState | null) => void;
  notify: (message: string, tone?: ChatActionTone) => void;
  setPermissionMode: (mode: PermissionMode) => void;
}

export interface ChatSlashActionDefinition {
  kind: "chat-action";
  id: string;
  label: string;
  description: string;
  /** Display + matching string, e.g. "/compact". */
  shortcut: string;
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

export const chatSlashActions: ChatSlashActionDefinition[] = [
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
    id: "permission",
    label: "Permission mode",
    description: "Switch permission level: read-only, workspace-write, or danger-full-access",
    shortcut: "/permission",
    // This action is handled specially by the chat screen to open the selector
    run: async () => {
      // Placeholder - actual handling happens in chat-screen via requestedChatActionId
    },
  },
  {
    kind: "chat-action",
    id: "model",
    label: "Switch model",
    description: "Pick any OpenRouter model; applies immediately and persists to settings.json",
    shortcut: "/model",
    // This action is handled specially by the chat screen to open the selector
    run: async () => {
      // Placeholder - actual handling happens in chat-screen via requestedChatActionId
    },
  },
];

export function findChatSlashAction(
  text: string,
): ChatSlashActionDefinition | null {
  const normalized = text.trim().toLowerCase();
  return (
    chatSlashActions.find((action) => action.shortcut === normalized) ?? null
  );
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

  return chatSlashActions.filter(
    (action) =>
      action.shortcut.replace(/^\//, "").toLowerCase().includes(normalized) ||
      action.label.toLowerCase().includes(normalized) ||
      action.description.toLowerCase().includes(normalized),
  );
}
