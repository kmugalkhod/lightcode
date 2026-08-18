import {
  resolveProviderWebSearchAccess,
  type CodingAgentMode,
  type CodingToolName,
  type PermissionMode,
  type PermissionRules,
  type ProviderWebSearchDecision,
  type ResolvedWebSearchCapability,
} from "@lightcode/ai";

export const providerWebSearchApprovalRequiredCode =
  "provider_web_search_approval_required" as const;

export interface ProviderWebSearchGateOptions {
  capability: Pick<ResolvedWebSearchCapability, "available" | "execution">;
  providerToolAvailable: boolean;
  /** Whether intent selection activated web_search for this provider turn. */
  requested?: boolean;
  mode: CodingAgentMode;
  permissionMode?: PermissionMode;
  allowedTools?: readonly CodingToolName[];
  permissionRules?: PermissionRules;
  decision?: ProviderWebSearchDecision;
}

/**
 * Provider-native tools must be admitted before generation. Local search is
 * deliberately not handled here because it retains query-level approval.
 */
export function resolveProviderWebSearchGate(
  options: ProviderWebSearchGateOptions,
) {
  if (
    options.requested === false ||
    !options.capability.available ||
    options.capability.execution !== "provider" ||
    !options.providerToolAvailable
  ) {
    return { action: "not-applicable" as const, permissionDecision: null };
  }

  return resolveProviderWebSearchAccess({
    mode: options.mode,
    permissionMode: options.permissionMode,
    allowedTools: options.allowedTools,
    permissionRules: options.permissionRules,
    decision: options.decision,
  });
}

export function providerWebSearchApprovalRequiredBody() {
  return {
    error:
      "Provider-native web search requires approval before this turn can start.",
    code: providerWebSearchApprovalRequiredCode,
  };
}
