import { z } from "zod";

export const sandboxModeSchema = z.enum([
  "disabled",
  "read-only",
  "workspace-write",
]);

export const sandboxNetworkPolicySchema = z.enum(["inherit", "disabled"]);

export const sandboxConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  mode: sandboxModeSchema.optional().default("disabled"),
  network: sandboxNetworkPolicySchema.optional().default("inherit"),
});

export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

export interface SandboxRuntimeStatus extends SandboxConfig {
  supported: boolean;
  isolation: "process-guards";
  unsupportedReason?: string;
}

export const sandboxRuntimeStatusSchema = sandboxConfigSchema.extend({
  supported: z.boolean(),
  isolation: z.literal("process-guards"),
  unsupportedReason: z.string().optional(),
});

export function getSandboxRuntimeStatus(
  config: SandboxConfig | undefined,
): SandboxRuntimeStatus {
  const parsedConfig = sandboxConfigSchema.parse(config ?? {});
  const enabled = parsedConfig.enabled || parsedConfig.mode !== "disabled";

  if (!enabled) {
    return {
      ...parsedConfig,
      enabled: false,
      supported: true,
      isolation: "process-guards",
    };
  }

  if (process.platform === "win32") {
    return {
      ...parsedConfig,
      enabled: true,
      supported: false,
      isolation: "process-guards",
      unsupportedReason:
        "Shell sandbox execution is not supported on Windows yet.",
    };
  }

  return {
    ...parsedConfig,
    enabled: true,
    supported: true,
    isolation: "process-guards",
    unsupportedReason:
      "Process-level path and command guards only; Lightcode does not provide OS-level filesystem or network isolation yet.",
  };
}
