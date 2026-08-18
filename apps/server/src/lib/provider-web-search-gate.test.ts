import { describe, expect, test } from "bun:test";
import {
  providerWebSearchApprovalRequiredBody,
  resolveProviderWebSearchGate,
} from "./provider-web-search-gate";

const providerCapability = {
  available: true,
  execution: "provider" as const,
};

describe("provider web-search pre-turn gate", () => {
  test("requires a decision when policy asks", () => {
    const gate = resolveProviderWebSearchGate({
      capability: providerCapability,
      providerToolAvailable: true,
      mode: "build",
      permissionMode: "workspace-write",
    });

    expect(gate.action).toBe("approval-required");
    expect(providerWebSearchApprovalRequiredBody()).toEqual({
      error:
        "Provider-native web search requires approval before this turn can start.",
      code: "provider_web_search_approval_required",
    });
  });

  test("approved exposes and denied omits an ask-level provider tool", () => {
    const base = {
      capability: providerCapability,
      providerToolAvailable: true,
      mode: "plan" as const,
    };

    expect(
      resolveProviderWebSearchGate({ ...base, decision: "approved" }).action,
    ).toBe("expose");
    expect(
      resolveProviderWebSearchGate({ ...base, decision: "denied" }).action,
    ).toBe("omit");
  });

  test("deny policy cannot be overridden and allow needs no flag", () => {
    const base = {
      capability: providerCapability,
      providerToolAvailable: true,
      mode: "build" as const,
      permissionMode: "danger-full-access" as const,
    };

    expect(resolveProviderWebSearchGate(base).action).toBe("expose");
    expect(
      resolveProviderWebSearchGate({
        ...base,
        decision: "approved",
        permissionRules: { deniedTools: ["web_search"] },
      }).action,
    ).toBe("omit");
  });

  test("does not pre-gate a local or unavailable backend", () => {
    expect(
      resolveProviderWebSearchGate({
        capability: { available: true, execution: "local" },
        providerToolAvailable: false,
        mode: "plan",
      }).action,
    ).toBe("not-applicable");
  });

  test("does not pre-gate provider search when this turn did not request it", () => {
    expect(
      resolveProviderWebSearchGate({
        capability: providerCapability,
        providerToolAvailable: true,
        requested: false,
        mode: "build",
        permissionMode: "workspace-write",
      }).action,
    ).toBe("not-applicable");
  });
});
