import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCodingTool } from "../runtime-registry";

const tempRoots: string[] = [];

async function makeTempWorkspace() {
  const directory = await mkdtemp(path.join(tmpdir(), "lightcode-todo-"));
  tempRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("todo_write runtime", () => {
  test("persists a session-scoped todo list", async () => {
    const cwd = await makeTempWorkspace();
    const output = await executeCodingTool(
      "todo_write",
      {
        todos: [
          {
            content: "Add git status tool",
            status: "completed",
            priority: "high",
          },
          {
            content: "Wire CLI todo display",
            status: "in_progress",
            priority: "medium",
          },
        ],
      },
      {
        cwd,
        sessionId: "session-123",
        mode: "build",
        permissionMode: "workspace-write",
      },
    );

    expect(output.sessionId).toBe("session-123");
    expect(output.summary.total).toBe(2);
    expect(output.summary.completed).toBe(1);
    expect(output.summary.inProgress).toBe(1);

    const rawTodos = await readFile(
      path.join(cwd, ".lightcode", "todos", "session-123.json"),
      "utf8",
    );

    expect(JSON.parse(rawTodos)).toEqual(output.todos);
  });
});
