import { describe, expect, test } from "bun:test";
import {
  findSlashCommand,
  formatSlashCommandUsage,
  getSlashCommandById,
  getSlashCommandSuggestions,
  isSlashCommandAvailable,
  parseSlashCommand,
  slashCommandRegistry,
} from "./slash-command-registry";

const parityCommandIds = [
  "copy",
  "export",
  "compact",
  "context",
  "abort",
  "undo",
  "redo",
  "skills",
  "permission",
  "home",
  "status",
  "doctor",
  "permissions",
  "sessions",
  "tools",
  "config",
  "connect",
  "model",
  "model-info",
  "latest",
  "help",
] as const;

describe("slash command registry", () => {
  test("covers CLI parity plus browser help without duplicate tokens", () => {
    expect(slashCommandRegistry.map(({ id }) => id)).toEqual([
      ...parityCommandIds,
    ]);

    const allTokens = slashCommandRegistry.flatMap((command) => [
      command.command,
      ...command.aliases,
    ]);
    expect(new Set(allTokens).size).toBe(allTokens.length);
  });

  test("carries explicit session availability and argument usage", () => {
    const copy = getSlashCommandById("copy");
    const home = getSlashCommandById("home");

    expect(copy.availability).toBe("session");
    expect(isSlashCommandAvailable(copy, false)).toBe(false);
    expect(isSlashCommandAvailable(copy, true)).toBe(true);
    expect(isSlashCommandAvailable(home, false)).toBe(true);
    expect(formatSlashCommandUsage(copy)).toBe("/copy [last|code|all]");
    expect(formatSlashCommandUsage(home)).toBe("/home");
  });
});

describe("slash command parsing", () => {
  test("parses an exact command and keeps its trimmed argument text", () => {
    expect(parseSlashCommand("  /copy   code  ")).toMatchObject({
      kind: "command",
      command: { id: "copy" },
      invokedAs: "/copy",
      args: "code",
      available: true,
    });
  });

  test("resolves aliases and command casing without treating prefixes as exact", () => {
    expect(parseSlashCommand("/STOP")).toMatchObject({
      kind: "command",
      command: { id: "abort" },
      invokedAs: "/stop",
    });
    expect(findSlashCommand("ctx")?.id).toBe("context");
    expect(parseSlashCommand("/con")).toMatchObject({
      kind: "unknown",
      invokedAs: "/con",
    });
  });

  test("distinguishes ordinary text, the bare menu trigger, and unknown commands", () => {
    expect(parseSlashCommand("please /copy this").kind).toBe("plain-text");
    expect(parseSlashCommand("/").kind).toBe("incomplete");

    const unknown = parseSlashCommand("/converge now");
    expect(unknown.kind).toBe("unknown");
    if (unknown.kind === "unknown") {
      expect(unknown.args).toBe("now");
      expect(unknown.suggestions).toEqual([]);
    }
  });

  test("reports a known session command as unavailable on home", () => {
    expect(parseSlashCommand("/undo", { hasSession: false })).toMatchObject({
      kind: "command",
      command: { id: "undo" },
      available: false,
    });
    expect(parseSlashCommand("/permission", { hasSession: false })).toMatchObject(
      {
        kind: "command",
        command: { id: "permission" },
        available: true,
      },
    );
  });
});

describe("slash command suggestions", () => {
  test("ranks canonical command prefixes before aliases and search terms", () => {
    expect(
      getSlashCommandSuggestions("/co", { limit: 5 }).map(({ id }) => id),
    ).toEqual(["copy", "compact", "context", "config", "connect"]);
    expect(getSlashCommandSuggestions("/can").map(({ id }) => id)).toEqual([
      "abort",
    ]);
    expect(getSlashCommandSuggestions("clipboard").map(({ id }) => id)).toEqual(
      ["copy"],
    );
  });

  test("keeps only the selected command while arguments are entered", () => {
    expect(getSlashCommandSuggestions("/copy all").map(({ id }) => id)).toEqual([
      "copy",
    ]);
    expect(getSlashCommandSuggestions("/missing value")).toEqual([]);
  });

  test("hides session commands on home unless unavailable entries are requested", () => {
    const homeIds = getSlashCommandSuggestions("/", {
      hasSession: false,
    }).map(({ id }) => id);
    expect(homeIds).not.toContain("copy");
    expect(homeIds).toContain("permission");

    const allIds = getSlashCommandSuggestions("/copy", {
      hasSession: false,
      includeUnavailable: true,
    }).map(({ id }) => id);
    expect(allIds).toEqual(["copy"]);
  });

  test("applies a safe stable result limit", () => {
    expect(getSlashCommandSuggestions("/")).toHaveLength(
      slashCommandRegistry.length,
    );
    expect(getSlashCommandSuggestions("/", { limit: 2 }).map(({ id }) => id)).toEqual(
      ["copy", "export"],
    );
    expect(getSlashCommandSuggestions("/", { limit: -1 })).toEqual([]);
  });
});
