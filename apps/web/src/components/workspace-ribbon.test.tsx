import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceRibbon } from "./workspace-ribbon";

function render(placement: "project" | "agent", mode: "plan" | "build" = "plan", isRunning = false) {
  return renderToStaticMarkup(<WorkspaceRibbon placement={placement} workspace={null} session={null}
    mode={mode} permissionMode="workspace-write" providerStatus={null} providerStatusError={false}
    isRunning={isRunning} isCreating={false} isPickingProject={false}
    onOpenMenu={() => {}} onOpenProject={() => {}} onModeChange={() => {}}
    onPermissionModeChange={() => {}} onOpenModels={() => {}} />);
}

test("project context is a compact folder action without a header or path subtitle", () => {
  const html = render("project");
  expect(html).toContain("Open project folder");
  expect(html).toContain("Open sessions");
  expect(html).not.toContain("<header");
  expect(html).not.toContain("<small");
  expect(html).not.toContain('aria-label="Agent mode"');
});

test("agent controls are separate from folder navigation and retain Plan read-only enforcement", () => {
  const html = render("agent");
  expect(html).toContain('aria-label="Agent mode"');
  expect(html).toContain('aria-label="Permission mode" disabled');
  expect(html).toContain('value="read-only" selected');
  expect(html).not.toContain("Open project folder");
  expect(html).not.toContain("<header");
});

test("running sessions disable both mode and permission controls", () => {
  const html = render("agent", "build", true);
  expect(html).toContain('aria-label="Agent mode" disabled');
  expect(html).toContain('aria-label="Permission mode" disabled');
});
