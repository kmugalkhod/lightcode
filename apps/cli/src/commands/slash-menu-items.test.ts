import { describe, expect, test } from "bun:test";
import { getSlashMenuItems } from "./slash-menu-items";
import { getSlashPageRoutes } from "../navigation/route-registry";
import {
  executeSessionHistoryAction,
  filterChatSlashActions,
  getChatSlashActionById,
  type ChatSlashActionContext,
} from "./chat-slash-actions";

describe("getSlashPageRoutes", () => {
  test("returns all routes for an empty query", () => {
    expect(getSlashPageRoutes("/").length).toBeGreaterThan(0);
  });

  test("filters by shortcut prefix", () => {
    const routes = getSlashPageRoutes("/sess");
    expect(routes.map((route) => route.id)).toEqual(["sessions"]);
  });

  test("does not match on descriptions", () => {
    // "session" appears in the /latest description; prefix+label matching
    // must not surface it.
    const routes = getSlashPageRoutes("/saved");
    expect(routes).toEqual([]);
  });
});

describe("filterChatSlashActions", () => {
  test("matches /skill to the skills action only", () => {
    const actions = filterChatSlashActions("/skill");
    expect(actions.map((action) => action.id)).toEqual(["skills"]);
  });

  test("does not match on descriptions", () => {
    // "clipboard" appears in the /copy description.
    expect(filterChatSlashActions("/clipboard")).toEqual([]);
  });
});

describe("getSlashMenuItems", () => {
  test("never returns two items with the same shortcut", () => {
    const items = getSlashMenuItems("/", { host: "chat" });
    const shortcuts = items.map((item) => item.shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  test("filters both chat actions and routes", () => {
    const items = getSlashMenuItems("/co", { host: "chat" });
    const shortcuts = items.map((item) => item.shortcut).sort();
    expect(shortcuts).toEqual([
      "/compact",
      "/config",
      "/connect",
      "/context",
      "/copy",
    ]);
  });

  test("home offers only home-eligible actions plus routes", () => {
    const items = getSlashMenuItems("/", { host: "home" });
    const actionIds = items
      .filter((item) => !("path" in item))
      .map((item) => item.id);
    expect(actionIds).toEqual(["permission"]);
  });

  test("other hosts get routes only", () => {
    const items = getSlashMenuItems("/permission", { host: "other" });
    expect(items.every((item) => "path" in item)).toBe(true);
  });
});

describe("abort chat action", () => {
  function createContext(
    isStreaming: boolean,
    abortActiveRun: () => Promise<void>,
    notices: Array<[string, "info" | "error" | undefined]>,
  ): ChatSlashActionContext {
    return {
      sessionId: "session-1",
      args: "",
      messages: [],
      setContextState: () => {},
      notify: (message, tone) => notices.push([message, tone]),
      setPermissionMode: () => {},
      copyToClipboard: async () => true,
      isStreaming,
      abortActiveRun,
      refreshMessages: async () => {},
    };
  }

  test("aborts an active run", async () => {
    let abortCount = 0;
    const notices: Array<[string, "info" | "error" | undefined]> = [];
    const action = getChatSlashActionById("abort");

    expect(action).not.toBeNull();
    await action!.run(
      createContext(
        true,
        async () => {
          abortCount += 1;
        },
        notices,
      ),
    );

    expect(abortCount).toBe(1);
    expect(notices.at(-1)).toEqual(["Active run aborted.", undefined]);
  });

  test("does not abort when no run is active", async () => {
    let abortCount = 0;
    const notices: Array<[string, "info" | "error" | undefined]> = [];
    const action = getChatSlashActionById("abort");

    await action!.run(
      createContext(
        false,
        async () => {
          abortCount += 1;
        },
        notices,
      ),
    );

    expect(abortCount).toBe(0);
    expect(notices).toEqual([["No active run to abort.", "error"]]);
  });
});

describe("session history actions", () => {
  test("refreshes canonical messages after undo", async () => {
    let refreshCount = 0;
    const notices: Array<[string, "info" | "error" | undefined]> = [];

    await executeSessionHistoryAction({
      action: "undo",
      post: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          turnKey: "turn-1",
          restoredFiles: ["src/app.ts"],
          messageCount: 4,
          revision: 7,
        }),
      }),
      refreshMessages: async () => {
        refreshCount += 1;
      },
      notify: (message, tone) => notices.push([message, tone]),
    });

    expect(refreshCount).toBe(1);
    expect(notices).toEqual([
      ["Undo complete: 1 file restored · 4 messages in the conversation.", undefined],
    ]);
  });

  test("surfaces a redo conflict without refreshing", async () => {
    let refreshCount = 0;
    const notices: Array<[string, "info" | "error" | undefined]> = [];

    await executeSessionHistoryAction({
      action: "redo",
      post: async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "There is no conversation turn to redo." }),
      }),
      refreshMessages: async () => {
        refreshCount += 1;
      },
      notify: (message, tone) => notices.push([message, tone]),
    });

    expect(refreshCount).toBe(0);
    expect(notices).toEqual([
      ["There is no conversation turn to redo.", "error"],
    ]);
  });
});
