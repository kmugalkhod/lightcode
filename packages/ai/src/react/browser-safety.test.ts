import { describe, expect, test } from "bun:test";

describe("@lightcode/ai/react browser entry", () => {
  test("bundles without importing Node execution runtimes", async () => {
    const result = await Bun.build({
      entrypoints: [new URL("./index.ts", import.meta.url).pathname],
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
