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
  unsupportedReason?: string;
}

export const sandboxRuntimeStatusSchema = sandboxConfigSchema.extend({
  supported: z.boolean(),
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
    };
  }

  if (process.platform === "win32") {
    return {
      ...parsedConfig,
      enabled: true,
      supported: false,
      unsupportedReason:
        "Shell sandbox execution is not supported on Windows yet.",
    };
  }

  return {
    ...parsedConfig,
    enabled: true,
    supported: true,
  };
}
