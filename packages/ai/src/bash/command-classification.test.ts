import { describe, expect, test } from "bun:test";
import { classifyBashCommand } from "./command-classification";

describe("bash command classification", () => {
  test("classifies known read-only commands", () => {
    expect(classifyBashCommand("ls").permissionMode).toBe("read-only");
    expect(classifyBashCommand("rg permission packages/ai/src").permissionMode).toBe(
      "read-only",
    );
    expect(classifyBashCommand("git status --short").permissionMode).toBe(
      "read-only",
    );
    expect(classifyBashCommand("git diff").permissionMode).toBe("read-only");
    expect(classifyBashCommand("bun run typecheck").permissionMode).toBe(
      "read-only",
    );
  });

  test("escalates redirects, deletes, package installs, network, and unknown commands", () => {
    expect(classifyBashCommand("cat package.json > out.txt").permissionMode).toBe(
      "danger-full-access",
    );
    expect(classifyBashCommand("rm -rf tmp").permissionMode).toBe(
      "danger-full-access",
    );
    expect(classifyBashCommand("bun install").permissionMode).toBe(
      "danger-full-access",
    );
    expect(classifyBashCommand("curl https://example.com").permissionMode).toBe(
      "danger-full-access",
    );
    expect(classifyBashCommand("custom-tool --flag").permissionMode).toBe(
      "danger-full-access",
    );
  });

  test("classifies simple workspace-local write commands", () => {
    expect(classifyBashCommand("mkdir tmp").permissionMode).toBe("workspace-write");
    expect(classifyBashCommand("touch notes.txt").permissionMode).toBe(
      "workspace-write",
    );
  });

  test("escalates commands that reference absolute or parent paths", () => {
    expect(classifyBashCommand("cat ../secret.txt").permissionMode).toBe(
      "danger-full-access",
    );
    expect(classifyBashCommand("mkdir C:\\temp\\x").permissionMode).toBe(
      "danger-full-access",
    );
  });
});
