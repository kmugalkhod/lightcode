import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("@lightcode/ai/react browser entry", () => {
  test("bundles without importing Node execution runtimes", async () => {
    const result = await Bun.build({
      // URL.pathname is "/D:/..." on Windows; fileURLToPath gives a real path.
      entrypoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      target: "browser",
      external: ["@ai-sdk/react", "@lightcode/shared", "ai", "react", "zod"],
    });

    expect(result.success).toBe(true);
    const bundledSource = await result.outputs[0]?.text();
    expect(bundledSource).toBeDefined();
    expect(bundledSource).not.toContain('from "node:');
    expect(bundledSource).not.toContain("process.cwd()");
    expect(bundledSource).not.toContain("loadSessionTodos");
  });
});
