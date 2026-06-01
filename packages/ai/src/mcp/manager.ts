import { mcpConfigSchema, type McpConfig, type McpResource } from "./config";

interface RunningServer {
  process: ReturnType<typeof Bun.spawn>;
  error: string | null;
}

export class McpServerManager {
  private readonly config: McpConfig;
  private readonly runningServers = new Map<string, RunningServer>();

  constructor(config: unknown) {
    this.config = mcpConfigSchema.parse(config ?? {});
  }

  listServers() {
    return Object.entries(this.config.servers).map(([name, server]) => {
      const running = this.runningServers.get(name);

      return {
        name,
        transport: "stdio" as const,
        enabled: server.enabled,
        state: running
          ? running.error
            ? "degraded"
            : "running"
          : server.enabled
            ? "stopped"
            : "stopped",
        command: server.command,
        pid: running?.process.pid ?? null,
        error: running?.error ?? null,
      };
    });
  }

  inspectServer(name: string) {
    return this.listServers().find((server) => server.name === name) ?? null;
  }

  startServer(name: string) {
    const server = this.config.servers[name];
    if (!server) {
      throw new Error(`MCP server is not configured: ${name}`);
    }

    if (!server.enabled) {
      throw new Error(`MCP server is disabled: ${name}`);
    }

    const existing = this.runningServers.get(name);
    if (existing) {
      return this.inspectServer(name);
    }

    try {
      const child = Bun.spawn([server.command, ...server.args], {
        cwd: server.cwd,
        env: {
          ...process.env,
          ...server.env,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.runningServers.set(name, {
        process: child,
        error: null,
      });
    } catch (error) {
      this.runningServers.set(name, {
        process: Bun.spawn(["cmd", "/c", "exit", "1"], {
          stdout: "pipe",
          stderr: "pipe",
        }),
        error: error instanceof Error ? error.message : "Unable to start MCP server.",
      });
    }

    return this.inspectServer(name);
  }

  stopServer(name: string) {
    const running = this.runningServers.get(name);
    if (running) {
      running.process.kill();
      this.runningServers.delete(name);
    }

    return this.inspectServer(name);
  }

  listResources(serverName?: string): {
    servers: ReturnType<McpServerManager["listServers"]>;
    resources: McpResource[];
  } {
    const servers = this.listServers().filter(
      (server) => !serverName || server.name === serverName,
    );

    // The first lifecycle version reports configured servers. Resource discovery
    // is filled once a stdio JSON-RPC bridge is attached to the running process.
    return {
      servers,
      resources: [],
    };
  }

  readResource(server: string, uri: string) {
    const status = this.inspectServer(server);
    if (!status) {
      throw new Error(`MCP server is not configured: ${server}`);
    }

    throw new Error(
      `MCP resource reading is not available until server "${server}" exposes resources over the stdio bridge (${uri}).`,
    );
  }

  callTool(server: string, toolName: string, args: Record<string, unknown>) {
    const status = this.inspectServer(server);
    if (!status) {
      throw new Error(`MCP server is not configured: ${server}`);
    }

    return {
      server,
      toolName,
      result: {
        status: "not_available",
        message:
          "MCP tool calls require the stdio JSON-RPC bridge to be connected.",
        arguments: args,
      },
    };
  }
}
