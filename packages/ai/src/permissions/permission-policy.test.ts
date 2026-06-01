import { describe, expect, test } from "bun:test";
import {
  evaluateCodingToolPermission,
  getActiveCodingToolsForPolicy,
  type CodingToolName,
  type PermissionRules,
} from "@lightcode/ai";

describe("coding permission policy", () => {
  test("read-only mode allows reads and denies mutations", () => {
    const readDecision = evaluateCodingToolPermission({
      toolName: "read_file",
      input: { path: "README.md" },
      mode: "plan",
    });
    const writeDecision = evaluateCodingToolPermission({
      toolName: "write_file",
      input: { path: "scratch.txt", content: "hello" },
      mode: "plan",
    });
    const editDecision = evaluateCodingToolPermission({
      toolName: "edit_file",
      input: { path: "scratch.txt", search: "hello", replace: "hi" },
      mode: "plan",
    });
    const bashDecision = evaluateCodingToolPermission({
      toolName: "bash",
      input: { command: "rm -rf tmp" },
      mode: "plan",
    });
    const overriddenPlanDecision = evaluateCodingToolPermission({
      toolName: "write_file",
      input: { path: "scratch.txt", content: "hello" },
      mode: "plan",
      permissionMode: "danger-full-access",
    });

    expect(readDecision.outcome).toBe("allow");
    expect(writeDecision.outcome).toBe("deny");
    expect(editDecision.outcome).toBe("deny");
    expect(bashDecision.outcome).toBe("deny");
    expect(overriddenPlanDecision.outcome).toBe("deny");
  });

  test("workspace-write mode allows file writes and edits", () => {
    const writeDecision = evaluateCodingToolPermission({
      toolName: "write_file",
      input: { path: "scratch.txt", content: "hello" },
      mode: "build",
    });
    const editDecision = evaluateCodingToolPermission({
      toolName: "edit_file",
      input: { path: "scratch.txt", search: "hello", replace: "hi" },
      mode: "build",
    });

    expect(writeDecision.outcome).toBe("allow");
    expect(editDecision.outcome).toBe("allow");
  });

  test("workspace-write mode allows read-only bash and asks before escalation", () => {
    const readOnlyDecision = evaluateCodingToolPermission({
      toolName: "bash",
      input: { command: "pwd" },
      mode: "build",
    });
    const askDecision = evaluateCodingToolPermission({
      toolName: "bash",
      input: { command: "bun -e \"console.log(1)\"" },
      mode: "build",
    });
    const approvedDecision = evaluateCodingToolPermission({
      toolName: "bash",
      input: { command: "bun -e \"console.log(1)\"" },
      mode: "build",
      approved: true,
    });

    expect(readOnlyDecision.outcome).toBe("allow");
    expect(askDecision.outcome).toBe("ask");
    expect(approvedDecision.outcome).toBe("allow");
  });

  test("allowedTools filters active tools and denies tools outside the allow-list", () => {
    const modeTools: CodingToolName[] = ["read_file", "write_file", "bash"];
    const activeTools = getActiveCodingToolsForPolicy({
      modeTools,
      mode: "build",
      allowedTools: ["read_file"],
    });
    const deniedDecision = evaluateCodingToolPermission({
      toolName: "write_file",
      input: { path: "scratch.txt", content: "hello" },
      mode: "build",
      allowedTools: ["read_file"],
    });

    expect(activeTools).toEqual(["read_file"]);
    expect(deniedDecision.outcome).toBe("deny");
  });

  test("permission rules can force ask and deny decisions", () => {
    const permissionRules = {
      ask: ["write_file(src/generated:*)"],
      deny: ["bash(rm:*)"],
    } satisfies PermissionRules;
    const askDecision = evaluateCodingToolPermission({
      toolName: "write_file",
      input: { path: "src/generated/client.ts", content: "export {};" },
      mode: "build",
      permissionRules,
    });
    const denyDecision = evaluateCodingToolPermission({
      toolName: "bash",
      input: { command: "rm -rf tmp" },
      mode: "build",
      permissionRules,
    });

    expect(askDecision.outcome).toBe("ask");
    expect(denyDecision.outcome).toBe("deny");
  });
});
