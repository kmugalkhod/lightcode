export type SlashCommandCategory =
  | "conversation"
  | "navigation"
  | "diagnostics"
  | "configuration";

export type SlashCommandAvailability = "always" | "session";

interface SlashCommandDefinitionShape {
  id: string;
  command: `/${string}`;
  label: string;
  description: string;
  category: SlashCommandCategory;
  availability: SlashCommandAvailability;
  argumentHint: string | null;
  aliases: readonly `/${string}`[];
  searchTerms: readonly string[];
}

/**
 * Browser-safe command metadata shared by the home and active-session
 * composers. Execution intentionally lives with the hosting surface.
 */
export const slashCommandRegistry = [
  {
    id: "copy",
    command: "/copy",
    label: "Copy",
    description: "Copy the last reply, its code blocks, or the conversation",
    category: "conversation",
    availability: "session",
    argumentHint: "[last|code|all]",
    aliases: ["/cp"],
    searchTerms: ["clipboard", "reply", "code", "transcript"],
  },
  {
    id: "export",
    command: "/export",
    label: "Export session",
    description: "Download the current chat session as Markdown",
    category: "conversation",
    availability: "session",
    argumentHint: null,
    aliases: ["/save"],
    searchTerms: ["download", "markdown", "transcript"],
  },
  {
    id: "compact",
    command: "/compact",
    label: "Compact context",
    description: "Summarize older messages to free context window space",
    category: "conversation",
    availability: "session",
    argumentHint: null,
    aliases: ["/summarize"],
    searchTerms: ["context", "tokens", "shorten"],
  },
  {
    id: "context",
    command: "/context",
    label: "Inspect context",
    description: "Show the provider request budget and compaction savings",
    category: "conversation",
    availability: "session",
    argumentHint: null,
    aliases: ["/ctx"],
    searchTerms: ["tokens", "budget", "prompt", "usage"],
  },
  {
    id: "abort",
    command: "/abort",
    label: "Abort active run",
    description: "Stop the current response and active tool work",
    category: "conversation",
    availability: "session",
    argumentHint: null,
    aliases: ["/cancel", "/stop"],
    searchTerms: ["interrupt", "run", "stream"],
  },
  {
    id: "undo",
    command: "/undo",
    label: "Undo last turn",
    description: "Rewind the latest turn and its file edits",
    category: "conversation",
    availability: "session",
    argumentHint: null,
    aliases: ["/rewind"],
    searchTerms: ["restore", "history", "files"],
  },
  {
    id: "redo",
    command: "/redo",
    label: "Redo last turn",
    description: "Replay the most recently undone turn and file edits",
    category: "conversation",
    availability: "session",
    argumentHint: null,
    aliases: ["/replay"],
    searchTerms: ["restore", "history", "files"],
  },
  {
    id: "skills",
    command: "/skills",
    label: "List skills",
    description: "Show skills available to the agent in this workspace",
    category: "conversation",
    availability: "session",
    argumentHint: null,
    aliases: ["/skill"],
    searchTerms: ["agents", "instructions", "extensions"],
  },
  {
    id: "permission",
    command: "/permission",
    label: "Permission mode",
    description: "Change the permission level used for the next turn",
    category: "configuration",
    availability: "always",
    argumentHint: "[read-only|workspace-write|danger-full-access]",
    aliases: ["/perm"],
    searchTerms: ["approval", "access", "sandbox", "mode"],
  },
  {
    id: "home",
    command: "/home",
    label: "Home",
    description: "Start a new session in the current workspace",
    category: "navigation",
    availability: "always",
    argumentHint: null,
    aliases: ["/new"],
    searchTerms: ["start", "workspace", "project"],
  },
  {
    id: "status",
    command: "/status",
    label: "Status",
    description: "Show server, model, database, session, and tool status",
    category: "diagnostics",
    availability: "always",
    argumentHint: null,
    aliases: [],
    searchTerms: ["health", "server", "database", "tools"],
  },
  {
    id: "doctor",
    command: "/doctor",
    label: "Doctor",
    description: "Run operational health checks",
    category: "diagnostics",
    availability: "always",
    argumentHint: null,
    aliases: ["/health"],
    searchTerms: ["diagnose", "checks", "troubleshoot"],
  },
  {
    id: "permissions",
    command: "/permissions",
    label: "Permissions",
    description: "Inspect permission rules, allowed tools, and sandbox guards",
    category: "diagnostics",
    availability: "always",
    argumentHint: null,
    aliases: ["/permission-info"],
    searchTerms: ["rules", "access", "sandbox", "tools"],
  },
  {
    id: "sessions",
    command: "/sessions",
    label: "Sessions",
    description: "Browse saved conversations",
    category: "navigation",
    availability: "always",
    argumentHint: null,
    aliases: ["/chats"],
    searchTerms: ["history", "conversations", "saved"],
  },
  {
    id: "tools",
    command: "/tools",
    label: "Tools",
    description: "List available tools and their permission requirements",
    category: "diagnostics",
    availability: "always",
    argumentHint: null,
    aliases: [],
    searchTerms: ["schemas", "capabilities", "permissions"],
  },
  {
    id: "config",
    command: "/config",
    label: "Config",
    description: "Show effective configuration without secrets",
    category: "configuration",
    availability: "always",
    argumentHint: null,
    aliases: ["/settings"],
    searchTerms: ["configuration", "preferences", "effective"],
  },
  {
    id: "connect",
    command: "/connect",
    label: "Provider setup",
    description: "Check connection and show trusted terminal setup instructions",
    category: "configuration",
    availability: "always",
    argumentHint: null,
    aliases: ["/provider"],
    searchTerms: ["setup", "credential", "api key", "authentication"],
  },
  {
    id: "model",
    command: "/model",
    label: "Switch model",
    description: "Inspect models or switch by exact model ID",
    category: "configuration",
    availability: "always",
    argumentHint: "[model-id]",
    aliases: ["/models", "/switch-model"],
    searchTerms: ["select", "provider", "catalog"],
  },
  {
    id: "model-info",
    command: "/model-info",
    label: "Model info",
    description: "Show the provider, model, base URL, and credential hints",
    category: "diagnostics",
    availability: "always",
    argumentHint: null,
    aliases: ["/current-model"],
    searchTerms: ["provider", "base url", "credential", "api key"],
  },
  {
    id: "latest",
    command: "/latest",
    label: "Resume latest",
    description: "Open the most recently updated saved session",
    category: "navigation",
    availability: "always",
    argumentHint: null,
    aliases: ["/resume"],
    searchTerms: ["recent", "session", "continue"],
  },
  {
    id: "help",
    command: "/help",
    label: "Command help",
    description: "List commands or explain one command",
    category: "navigation",
    availability: "always",
    argumentHint: "[command]",
    aliases: ["/commands"],
    searchTerms: ["shortcuts", "usage", "documentation"],
  },
] as const satisfies readonly SlashCommandDefinitionShape[];

export type SlashCommandDefinition = (typeof slashCommandRegistry)[number];
export type SlashCommandId = SlashCommandDefinition["id"];

export interface SlashCommandSuggestionOptions {
  hasSession?: boolean;
  includeUnavailable?: boolean;
  limit?: number;
}

export type SlashCommandParseResult =
  | { kind: "plain-text"; input: string }
  | { kind: "incomplete"; input: string }
  | {
      kind: "command";
      input: string;
      command: SlashCommandDefinition;
      invokedAs: string;
      args: string;
      available: boolean;
    }
  | {
      kind: "unknown";
      input: string;
      invokedAs: string;
      args: string;
      suggestions: SlashCommandDefinition[];
    };

function normalizeCommandToken(value: string): string {
  const token = value.trim().toLowerCase();
  return token.startsWith("/") ? token : `/${token}`;
}

function commandTokens(command: SlashCommandDefinition): readonly string[] {
  return [command.command, ...command.aliases];
}

export function getSlashCommandById(
  id: SlashCommandId,
): SlashCommandDefinition {
  const command = slashCommandRegistry.find((candidate) => candidate.id === id);
  if (!command) {
    throw new Error(`Unknown slash command id: ${id}`);
  }
  return command;
}

/** Resolve only a complete canonical command or alias, never a prefix. */
export function findSlashCommand(
  commandToken: string,
): SlashCommandDefinition | null {
  const normalized = normalizeCommandToken(commandToken);
  return (
    slashCommandRegistry.find((command) =>
      commandTokens(command).some((token) => token === normalized),
    ) ?? null
  );
}

export function isSlashCommandAvailable(
  command: SlashCommandDefinition,
  hasSession: boolean,
): boolean {
  return command.availability === "always" || hasSession;
}

export function formatSlashCommandUsage(
  command: SlashCommandDefinition,
): string {
  return command.argumentHint
    ? `${command.command} ${command.argumentHint}`
    : command.command;
}

function suggestionScore(
  command: SlashCommandDefinition,
  normalizedQuery: string,
): number | null {
  const canonical = command.command.slice(1);
  const aliases = command.aliases.map((alias) => alias.slice(1));
  const label = command.label.toLowerCase();
  const labelWords = label.split(/\s+/);
  const searchTerms = command.searchTerms.map((term) => term.toLowerCase());

  if (canonical === normalizedQuery) return 0;
  if (canonical.startsWith(normalizedQuery)) return 1;
  if (aliases.some((alias) => alias === normalizedQuery)) return 2;
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) return 3;
  if (labelWords.some((word) => word.startsWith(normalizedQuery))) return 4;
  if (searchTerms.some((term) => term.startsWith(normalizedQuery))) return 5;
  if (label.includes(normalizedQuery)) return 6;
  return null;
}

function normalizeSuggestionQuery(input: string): {
  query: string;
  hasArgumentBoundary: boolean;
} {
  const trimmed = input.trim().toLowerCase().replace(/^\//, "");
  const boundary = trimmed.search(/\s/);
  if (boundary === -1) {
    return { query: trimmed, hasArgumentBoundary: false };
  }

  return {
    query: trimmed.slice(0, boundary),
    hasArgumentBoundary: true,
  };
}

/**
 * Return stable, prefix-ranked palette suggestions. Once argument entry has
 * begun (for example `/copy all`), only that exact command remains visible.
 */
export function getSlashCommandSuggestions(
  input = "",
  options: SlashCommandSuggestionOptions = {},
): SlashCommandDefinition[] {
  const {
    hasSession = true,
    includeUnavailable = false,
    limit = slashCommandRegistry.length,
  } = options;
  const { query, hasArgumentBoundary } = normalizeSuggestionQuery(input);
  const safeLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : slashCommandRegistry.length;

  const available = slashCommandRegistry.filter(
    (command) =>
      includeUnavailable || isSlashCommandAvailable(command, hasSession),
  );

  if (!query) {
    return available.slice(0, safeLimit);
  }

  if (hasArgumentBoundary) {
    const exact = findSlashCommand(query);
    return exact &&
      (includeUnavailable || isSlashCommandAvailable(exact, hasSession))
      ? [exact].slice(0, safeLimit)
      : [];
  }

  return available
    .map((command, index) => ({
      command,
      index,
      score: suggestionScore(command, query),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        command: SlashCommandDefinition;
        index: number;
        score: number;
      } => candidate.score !== null,
    )
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, safeLimit)
    .map(({ command }) => command);
}

/** Parse a slash command without allowing a partial command to execute. */
export function parseSlashCommand(
  input: string,
  options: Pick<SlashCommandSuggestionOptions, "hasSession"> = {},
): SlashCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "plain-text", input };
  }

  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return { kind: "incomplete", input };
  }

  const invokedAs = normalizeCommandToken(match[1] ?? "");
  const args = (match[2] ?? "").trim();
  const command = findSlashCommand(invokedAs);
  const hasSession = options.hasSession ?? true;

  if (command) {
    return {
      kind: "command",
      input,
      command,
      invokedAs,
      args,
      available: isSlashCommandAvailable(command, hasSession),
    };
  }

  return {
    kind: "unknown",
    input,
    invokedAs,
    args,
    suggestions: getSlashCommandSuggestions(invokedAs, { hasSession, limit: 5 }),
  };
}
