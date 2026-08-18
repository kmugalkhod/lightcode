import { describe, expect, test } from "bun:test";
import {
  clampCommandSelection,
  commandRegistry,
  getCommands,
  searchCommands,
} from "./command-registry";

describe("commandRegistry", () => {
  test("contains each executable action once", () => {
    const ids = commandRegistry.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("exposes chat actions only where they can run", () => {
    expect(getCommands("chat").map((command) => command.id)).toContain(
      "chat:compact",
    );
    expect(getCommands("chat").map((command) => command.id)).toContain(
      "chat:abort",
    );
    expect(getCommands("chat").map((command) => command.id)).toContain(
      "chat:redo",
    );
    expect(getCommands("home").map((command) => command.id)).toContain(
      "chat:permission",
    );
    expect(getCommands("home").map((command) => command.id)).not.toContain(
      "chat:compact",
    );
    expect(
      getCommands("other").some((command) => command.id.startsWith("chat:")),
    ).toBe(false);
  });

  test("finds slash actions from the command palette", () => {
    expect(searchCommands("compact", "chat").map((command) => command.id)).toContain(
      "chat:compact",
    );
    expect(searchCommands("free context", "chat").map((command) => command.id)).toEqual([
      "chat:compact",
    ]);
  });
});

describe("clampCommandSelection", () => {
  test("resets empty and negative selections to zero", () => {
    expect(clampCommandSelection(4, 0)).toBe(0);
    expect(clampCommandSelection(-3, 5)).toBe(0);
  });

  test("clamps stale selections after filtering", () => {
    expect(clampCommandSelection(7, 2)).toBe(1);
    expect(clampCommandSelection(1, 4)).toBe(1);
  });
});
