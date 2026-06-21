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

  test("demotes extra in_progress tasks to a single one and warns", async () => {
    const cwd = await makeTempWorkspace();
    const output = await executeCodingTool(
      "todo_write",
      {
        todos: [
          { content: "First task", status: "in_progress", priority: "medium" },
          { content: "Second task", status: "in_progress", priority: "medium" },
          { content: "Third task", status: "pending", priority: "medium" },
        ],
      },
      { cwd, sessionId: "s", mode: "build", permissionMode: "workspace-write" },
    );

    expect(output.summary.inProgress).toBe(1);
    expect(output.todos[0].status).toBe("in_progress");
    expect(output.todos[1].status).toBe("pending");
    expect(output.warnings?.some((w) => w.includes("in_progress"))).toBe(true);
  });

  test("warns when no task is in_progress but pending work remains", async () => {
    const cwd = await makeTempWorkspace();
    const output = await executeCodingTool(
      "todo_write",
      {
        todos: [
          { content: "Done task", status: "completed", priority: "medium" },
          { content: "Next task", status: "pending", priority: "medium" },
        ],
      },
      { cwd, sessionId: "s", mode: "build", permissionMode: "workspace-write" },
    );

    expect(output.summary.inProgress).toBe(0);
    expect(output.warnings?.some((w) => w.includes("in_progress"))).toBe(true);
  });

  test("warns when a previously completed task regresses", async () => {
    const cwd = await makeTempWorkspace();
    await executeCodingTool(
      "todo_write",
      {
        todos: [
          { content: "Build feature", status: "completed", priority: "medium" },
        ],
      },
      { cwd, sessionId: "s", mode: "build", permissionMode: "workspace-write" },
    );

    const output = await executeCodingTool(
      "todo_write",
      {
        todos: [
          {
            content: "Build feature",
            status: "in_progress",
            priority: "medium",
          },
        ],
      },
      { cwd, sessionId: "s", mode: "build", permissionMode: "workspace-write" },
    );

    expect(output.warnings?.some((w) => w.includes("monotonic"))).toBe(true);
  });

  test("persists the optional activeForm for the in_progress item", async () => {
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
            activeForm: "Wiring CLI todo display",
          },
        ],
      },
      {
        cwd,
        sessionId: "session-active",
        mode: "build",
        permissionMode: "workspace-write",
      },
    );

    expect(output.todos[1].activeForm).toBe("Wiring CLI todo display");
    expect(output.todos[0].activeForm).toBeUndefined();

    const rawTodos = await readFile(
      path.join(cwd, ".lightcode", "todos", "session-active.json"),
      "utf8",
    );
    expect(JSON.parse(rawTodos)[1].activeForm).toBe("Wiring CLI todo display");
  });

  test("accepts content up to TODO_CONTENT_MAX_CHARS and rejects over-cap", async () => {
    const cwd = await makeTempWorkspace();

    // Content at exactly the cap is accepted and not flagged.
    const exact = "x".repeat(200);
    const okOutput = await executeCodingTool(
      "todo_write",
      {
        todos: [
          { content: exact, status: "in_progress", priority: "medium" },
        ],
      },
      { cwd, sessionId: "s", mode: "build", permissionMode: "workspace-write" },
    );

    expect(okOutput.todos[0].content).toBe(exact);
    expect(okOutput.todos[0].content.length).toBe(200);
    expect(okOutput.warnings ?? []).toEqual([]);

    // Over-cap content is rejected by validation rather than truncated.
    await expect(
      executeCodingTool(
        "todo_write",
        {
          todos: [
            {
              content: "x".repeat(400),
              status: "in_progress",
              priority: "medium",
            },
          ],
        },
        { cwd, sessionId: "s2", mode: "build", permissionMode: "workspace-write" },
      ),
    ).rejects.toThrow();
  });
});
