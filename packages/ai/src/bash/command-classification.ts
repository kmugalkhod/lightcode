import { permissionModeSchema, type PermissionMode } from "../permissions";

export interface BashCommandClassification {
  permissionMode: PermissionMode;
  reason: string;
  baseCommand?: string;
}

const readOnlyCommands = new Set([
  "cat",
  "dir",
  "findstr",
  "get-childitem",
  "get-content",
  "grep",
  "ls",
  "pwd",
  "rg",
  "select-string",
  "type",
]);

const packageManagerCommands = new Set(["bun", "bunx", "npm", "npx", "pnpm", "yarn"]);
const networkCommands = new Set([
  "curl",
  "ftp",
  "iwr",
  "invoke-restmethod",
  "invoke-webrequest",
  "nc",
  "netcat",
  "scp",
  "sftp",
  "ssh",
  "telnet",
  "wget",
]);
const deleteCommands = new Set(["del", "erase", "rd", "rm", "rmdir", "remove-item"]);
const processControlCommands = new Set([
  "kill",
  "pkill",
  "start-process",
  "stop-process",
  "taskkill",
]);
const workspaceWriteCommands = new Set(["mkdir", "new-item", "touch"]);
const readOnlyGitSubcommands = new Set(["diff", "log", "show", "status"]);

function decision(
  permissionMode: PermissionMode,
  reason: string,
  baseCommand?: string,
): BashCommandClassification {
  return {
    permissionMode: permissionModeSchema.parse(permissionMode),
    reason,
    baseCommand,
  };
}

function normalizeCommandToken(token: string): string {
  return token
    .trim()
    .replace(/\.(?:cmd|exe|bat|ps1)$/i, "")
    .toLowerCase();
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];

    if ((character === '"' || character === "'") && quote === null) {
      quote = character;
      continue;
    }

    if (character === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(character) && quote === null) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function hasShellControlSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const nextCharacter = command[index + 1];

    if ((character === '"' || character === "'") && quote === null) {
      quote = character;
      continue;
    }

    if (character === quote) {
      quote = null;
      continue;
    }

    if (quote !== null) {
      continue;
    }

    if (
      character === ">" ||
      character === "<" ||
      character === "|" ||
      character === ";" ||
      character === "`" ||
      character === "&"
    ) {
      return true;
    }

    if (character === "$" && nextCharacter === "(") {
      return true;
    }
  }

  return false;
}

function hasUnsafePathToken(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    if (!token || token.startsWith("-")) {
      return false;
    }

    if (/^[a-z]:[\\/]/i.test(token) || token.startsWith("/") || token.startsWith("~")) {
      return true;
    }

    return token.split(/[\\/]+/).includes("..");
  });
}

function classifyGitCommand(tokens: readonly string[], baseCommand: string) {
  const subcommand = tokens[1]?.toLowerCase();
  if (!subcommand) {
    return decision("read-only", "git with no subcommand only prints help.", baseCommand);
  }

  if (!readOnlyGitSubcommands.has(subcommand)) {
    return decision(
      "danger-full-access",
      `git ${subcommand} may mutate repository state or run hooks.`,
      baseCommand,
    );
  }

  if (tokens.some((token) => token.startsWith("--output"))) {
    return decision(
      "danger-full-access",
      "git diff/show output options can write files.",
      baseCommand,
    );
  }

  if (hasUnsafePathToken(tokens.slice(2))) {
    return decision(
      "danger-full-access",
      "git read command references a path outside the workspace.",
      baseCommand,
    );
  }

  return decision("read-only", `git ${subcommand} is treated as read-only.`, baseCommand);
}

function classifyBunCommand(tokens: readonly string[], baseCommand: string) {
  if (tokens[1] === "run" && tokens[2] === "typecheck") {
    return decision("read-only", "bun run typecheck is treated as read-only.", baseCommand);
  }

  if (["add", "install", "link", "remove", "unlink", "update", "upgrade"].includes(tokens[1] ?? "")) {
    return decision(
      "danger-full-access",
      `bun ${tokens[1]} can change dependencies or run lifecycle scripts.`,
      baseCommand,
    );
  }

  return decision(
    "danger-full-access",
    "bun commands other than the known typecheck script can run arbitrary package scripts.",
    baseCommand,
  );
}

function classifyPackageManagerCommand(tokens: readonly string[], baseCommand: string) {
  if (baseCommand === "bun") {
    return classifyBunCommand(tokens, baseCommand);
  }

  return decision(
    "danger-full-access",
    `${baseCommand} can install packages, run scripts, or access the network.`,
    baseCommand,
  );
}

export function classifyBashCommand(command: string): BashCommandClassification {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return decision("danger-full-access", "Empty shell commands are not executable.");
  }

  if (hasShellControlSyntax(trimmedCommand)) {
    return decision(
      "danger-full-access",
      "Shell control operators, redirects, pipes, or substitutions require full approval.",
    );
  }

  const tokens = tokenizeCommand(trimmedCommand);
  const baseCommand = normalizeCommandToken(tokens[0] ?? "");
  if (!baseCommand) {
    return decision("danger-full-access", "Unable to identify the shell command.");
  }

  if (networkCommands.has(baseCommand)) {
    return decision(
      "danger-full-access",
      `${baseCommand} can access the network or remote systems.`,
      baseCommand,
    );
  }

  if (deleteCommands.has(baseCommand)) {
    return decision(
      "danger-full-access",
      `${baseCommand} can delete files or directories.`,
      baseCommand,
    );
  }

  if (processControlCommands.has(baseCommand)) {
    return decision(
      "danger-full-access",
      `${baseCommand} can control processes outside the workspace.`,
      baseCommand,
    );
  }

  if (packageManagerCommands.has(baseCommand)) {
    return classifyPackageManagerCommand(tokens, baseCommand);
  }

  if (baseCommand === "git") {
    return classifyGitCommand(tokens, baseCommand);
  }

  if (readOnlyCommands.has(baseCommand)) {
    if (hasUnsafePathToken(tokens.slice(1))) {
      return decision(
        "danger-full-access",
        `${baseCommand} references an absolute, home, or parent path.`,
        baseCommand,
      );
    }

    return decision("read-only", `${baseCommand} is treated as a read-only command.`, baseCommand);
  }

  if (workspaceWriteCommands.has(baseCommand)) {
    if (hasUnsafePathToken(tokens.slice(1))) {
      return decision(
        "danger-full-access",
        `${baseCommand} references an absolute, home, or parent path.`,
        baseCommand,
      );
    }

    return decision(
      "workspace-write",
      `${baseCommand} is treated as a workspace-local write command.`,
      baseCommand,
    );
  }

  return decision(
    "danger-full-access",
    `Unknown shell command "${baseCommand}" requires full approval.`,
    baseCommand,
  );
}
