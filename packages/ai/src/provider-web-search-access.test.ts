import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { resolveProviderWebSearchAccess } from "./agent-tools";
import {
  createCodingAgent,
  resolveCodingAgentCallSettings,
} from "./coding-agent";

const providerSearchPrompt = "Search the web for the current release notes.";

function resolveSettings({
  permissionMode = "workspace-write" as const,
  providerWebSearchDecision,
  permissionRules,
}: {
  permissionMode?: "workspace-write" | "danger-full-access";
  providerWebSearchDecision?: "approved" | "denied";
  permissionRules?: { deniedTools?: ["web_search"] };
}) {
  return resolveCodingAgentCallSettings({
    options: {
      cwd: "/workspace",
      mode: "build",
      permissionMode,
      providerWebSearchDecision,
      permissionRules,
    },
    prompt: providerSearchPrompt,
    messages: undefined,
    includeToolDiscipline: false,
    providerWebSearchTool: true,
  });
}

describe("provider web-search request admission", () => {
  test("ask policy requires pre-approval and omits the provider tool meanwhile", () => {
    const access = resolveProviderWebSearchAccess({
      mode: "build",
      permissionMode: "workspace-write",
    });
    const settings = resolveSettings({});

    expect(access.action).toBe("approval-required");
    expect(settings.providerWebSearchAccess?.action).toBe("approval-required");
    expect(settings.activeTools).not.toContain("web_search");
  });

  test("approved exposes, denied omits, and deny policy cannot be overridden", () => {
    expect(
      resolveSettings({ providerWebSearchDecision: "approved" }).activeTools,
    ).toContain("web_search");
    expect(
      resolveSettings({ providerWebSearchDecision: "denied" }).activeTools,
    ).not.toContain("web_search");
    expect(
      resolveSettings({
        providerWebSearchDecision: "approved",
        permissionRules: { deniedTools: ["web_search"] },
      }).activeTools,
    ).not.toContain("web_search");
  });

  test("allow policy exposes without a decision, while explicit denial still omits", () => {
    expect(
      resolveSettings({ permissionMode: "danger-full-access" }).activeTools,
    ).toContain("web_search");
    expect(
      resolveSettings({
        permissionMode: "danger-full-access",
        providerWebSearchDecision: "denied",
      }).activeTools,
    ).not.toContain("web_search");
  });

  test("provider tool is installed raw without post-call needsApproval", () => {
    const providerTool = tool({
      inputSchema: z.object({ query: z.string() }),
    });
    const agent = createCodingAgent({
      model: new MockLanguageModelV3(),
      webSearch: { available: true, providerTool },
    });

    expect(agent.tools.web_search).toBe(providerTool);
    expect("needsApproval" in agent.tools.web_search).toBe(false);
  });
});
