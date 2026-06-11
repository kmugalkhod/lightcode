import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Credentials stored by first-run onboarding at ~/.lightcode/credentials.json.
 * Environment variables always take precedence over stored values.
 */
export const storedCredentialsSchema = z
  .object({
    anthropicApiKey: z.string().min(1).optional(),
    openaiCompatibleApiKey: z.string().min(1).optional(),
    opencodeApiKey: z.string().min(1).optional(),
    openrouterApiKey: z.string().min(1).optional(),
  })
  .strict();
export type StoredCredentials = z.infer<typeof storedCredentialsSchema>;

export function getCredentialsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configuredPath = env.LIGHTCODE_CREDENTIALS?.trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.join(os.homedir(), ".lightcode", "credentials.json");
}

export function readStoredCredentials(
  env: Record<string, string | undefined> = process.env,
): StoredCredentials {
  const credentialsPath = getCredentialsPath(env);
  if (!existsSync(credentialsPath)) {
    return {};
  }

  try {
    const parsed = storedCredentialsSchema.safeParse(
      JSON.parse(readFileSync(credentialsPath, "utf8")),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeStoredCredentials(
  credentials: StoredCredentials,
  env: Record<string, string | undefined> = process.env,
): string {
  const credentialsPath = getCredentialsPath(env);
  const merged = storedCredentialsSchema.parse({
    ...readStoredCredentials(env),
    ...credentials,
  });

  mkdirSync(path.dirname(credentialsPath), { recursive: true });
  writeFileSync(credentialsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  try {
    // Best-effort on Windows; meaningful on POSIX systems.
    chmodSync(credentialsPath, 0o600);
  } catch {
    // Ignore — the file still lives under the user profile.
  }

  return credentialsPath;
}
