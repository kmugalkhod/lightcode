import { describe, expect, test } from "bun:test";
import { mcpConfigSchema } from "./config";
import { McpServerManager } from "./manager";

describe("mcp config and lifecycle", () => {
  test("parses stdio server definitions and reports stopped status", () => {
    const config = mcpConfigSchema.parse({
      servers: {
        demo: {
          command: "node",
          args: ["server.js"],
        },
      },
    });

    const manager = new McpServerManager(config);
    expect(manager.listServers()).toEqual([
      {
        name: "demo",
        transport: "stdio",
        enabled: true,
        state: "stopped",
        command: "node",
        pid: null,
        error: null,
      },
    ]);
  });
});
