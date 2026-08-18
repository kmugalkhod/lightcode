import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readStoredCredentials, writeStoredCredentials } from "./credentials";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("stored search credentials", () => {
  test("round-trips Brave/Tavily keys in the protected credential file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lightcode-credentials-"));
    tempDirectories.push(directory);
    const credentialsPath = path.join(directory, "credentials.json");
    const env = { LIGHTCODE_CREDENTIALS: credentialsPath };

    expect(
      writeStoredCredentials(
        {
          braveSearchApiKey: "brave-secret",
          tavilyApiKey: "tavily-secret",
        },
        env,
      ),
    ).toBe(credentialsPath);
    expect(readStoredCredentials(env)).toEqual({
      braveSearchApiKey: "brave-secret",
      tavilyApiKey: "tavily-secret",
    });

    if (process.platform !== "win32") {
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    }
  });
});
