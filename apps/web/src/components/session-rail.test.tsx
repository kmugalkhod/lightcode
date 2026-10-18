import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RecentProject, Session, Workspace } from "../lib/api";
import { groupSessionsByProject, recentProjectForSession, SessionRail } from "./session-rail";

function session(id: string, cwd: string | null, updatedAt: string, title = id): Session {
  return {
    id,
    title,
    cwd,
    mode: "build",
    permissionMode: null,
    model: null,
    revision: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}

const workspace: Workspace = {
  id: "ws-1",
  name: "lightcode",
  pathLabel: "lightcode",
  hostPath: String.raw`D:\Self-Project\lightcode`,
  createdAt: "2026-10-01T00:00:00.000Z",
};

const sessions = [
  session("a", String.raw`D:\Self-Project\notely`, "2026-10-16T10:00:00.000Z"),
  session("b", String.raw`D:\Self-Project\lightcode`, "2026-10-15T10:00:00.000Z"),
  session("c", "d:/self-project/lightcode/", "2026-10-16T09:00:00.000Z"),
  session("d", null, "2026-10-16T11:00:00.000Z"),
  session("e", String.raw`D:\Self-Project\notely`, "2026-10-14T10:00:00.000Z"),
];

test("groups sessions by project folder, open project first and folderless sessions last", () => {
  const groups = groupSessionsByProject(sessions, workspace);
  expect(groups.map((group) => group.name)).toEqual(["lightcode", "notely", "Other"]);
  expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["c", "b"]);
  expect(groups[1]?.sessions.map((item) => item.id)).toEqual(["a", "e"]);
});

test("without an open project, groups follow their most recent activity", () => {
  const groups = groupSessionsByProject(sessions, null);
  expect(groups.map((group) => group.name)).toEqual(["notely", "lightcode", "Other"]);
});

test("project headers are expandable toggles that list their sessions", () => {
  const html = renderToStaticMarkup(
    <SessionRail sessions={sessions} activeSessionId="b" workspace={workspace} isLoading={false}
      isPickingProject={false} isRunning={false} error={null} mobileOpen={false} backgroundInert={false}
      onCloseMobile={() => {}} onNewSession={() => {}} onOpenProject={() => {}}
      onSelectSession={() => {}} onRetry={() => {}} />,
  );
  expect(html.match(/class="session-group-header"/g)?.length).toBe(3);
  expect(html).toContain('aria-expanded="true"');
  expect(html.indexOf("lightcode</span>")).toBeLessThan(html.indexOf("notely</span>"));
  expect(html).toContain('aria-current="page"');
});

test("long projects show the newest sessions and fold the rest behind Show more", () => {
  const many = Array.from({ length: 8 }, (_, index) =>
    session(`s${index}`, "/home/me/app", `2026-10-1${index}T00:00:00.000Z`, `Session ${index}`));
  const html = renderToStaticMarkup(
    <SessionRail sessions={many} activeSessionId="s0" workspace={null} isLoading={false}
      isPickingProject={false} isRunning={false} error={null} mobileOpen={false} backgroundInert={false}
      onCloseMobile={() => {}} onNewSession={() => {}} onOpenProject={() => {}}
      onSelectSession={() => {}} onRetry={() => {}} />,
  );
  // Newest five plus the active (oldest) session; two stay folded.
  expect(html.match(/class="session-item/g)?.length).toBe(6);
  expect(html).toContain("Session 0");
  expect(html).not.toContain("Session 2<");
  expect(html).toContain("Show 2 more");
});

test("New session stays clickable before a project is open", () => {
  const html = renderToStaticMarkup(
    <SessionRail sessions={sessions} activeSessionId="b" workspace={null} isLoading={false}
      isPickingProject={false} isRunning={false} error={null} mobileOpen={false} backgroundInert={false}
      onCloseMobile={() => {}} onNewSession={() => {}} onOpenProject={() => {}}
      onSelectSession={() => {}} onRetry={() => {}} />,
  );
  const newSessionButton = html.match(/<button class="rail-nav-item"[^>]*>/)?.[0];
  expect(newSessionButton).toBeDefined();
  expect(newSessionButton).not.toContain("disabled");
});

test("a session's folder resolves to its openable recent project", () => {
  const recent = (pathLabel: string, available = true): RecentProject => ({
    key: "k".repeat(22),
    name: pathLabel.split(/[\/]/).at(-1) ?? pathLabel,
    pathLabel,
    lastUsedAt: "2026-10-16T00:00:00.000Z",
    available,
  });
  const todo = recent(String.raw`D:\Lightcode-TodoApp`);
  const projects = [recent(String.raw`D:\Self-Project\notely`), todo];
  expect(recentProjectForSession(session("t", "d:/lightcode-todoapp/", "2026-10-16T00:00:00.000Z"), projects)).toBe(todo);
  expect(recentProjectForSession(session("t", String.raw`D:\Lightcode-TodoApp`, "2026-10-16T00:00:00.000Z"), [recent(String.raw`D:\Lightcode-TodoApp`, false)])).toBeNull();
  expect(recentProjectForSession(session("d", null, "2026-10-16T00:00:00.000Z"), projects)).toBeNull();
  expect(recentProjectForSession(null, projects)).toBeNull();
});
