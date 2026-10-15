import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LightcodeApi, RecentProject } from "../lib/api";
import { ProjectBrowser } from "./project-browser";

const recent: RecentProject = {
  key: "AAAAAAAAAAAAAAAAAAAAAA",
  name: "lightcode",
  pathLabel: "D:\\Self-Project\\lightcode",
  available: true,
  lastUsedAt: "2026-10-15T00:00:00.000Z",
};

function render(overrides: Partial<Parameters<typeof ProjectBrowser>[0]> = {}) {
  return renderToStaticMarkup(
    <ProjectBrowser
      api={{} as LightcodeApi}
      dismissible
      nativePickerPending={false}
      notice={null}
      onClose={() => {}}
      onSelect={() => {}}
      recentProjects={[recent]}
      onOpenRecent={() => {}}
      systemPickerLabel="Use Windows dialog"
      onUseSystemPicker={() => {}}
      onCancelSystemPicker={() => {}}
      compact={false}
      {...overrides}
    />,
  );
}

describe("ProjectBrowser", () => {
  test("renders a modal file-browser window with places, address bar and actions", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Open a project");
    expect(html).toContain('aria-label="Places"');
    expect(html).toContain('aria-label="Current folder"');
    // Recent projects are one click away in the sidebar.
    expect(html).toContain(">lightcode<");
    expect(html).toContain("Use Windows dialog");
    expect(html).toContain(">Cancel<");
    // Nothing is chosen yet, so Open project stays disabled.
    expect(html).toMatch(/<button class="primary-button" type="button" disabled="">Open project<\/button>/);
  });

  test("offers cancel while the OS dialog is opening and hides it when unsupported", () => {
    expect(render({ nativePickerPending: true })).toContain("Cancel dialog");
    expect(render({ systemPickerLabel: null })).not.toContain("Use Windows dialog");
  });

  test("goes full screen on narrow viewports", () => {
    expect(render({ compact: true })).toContain('class="project-browser-backdrop compact"');
  });
});
