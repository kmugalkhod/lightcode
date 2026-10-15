import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LightcodeApi } from "../lib/api";
import { ChangesPanel } from "./changes-panel";

describe("ChangesPanel", () => {
  test("renders an accessible, closable panel shell before data loads", () => {
    const html = renderToStaticMarkup(
      <ChangesPanel
        api={{} as LightcodeApi}
        sessionId="11111111-1111-4111-8111-111111111111"
        refreshKey={0}
        onClose={() => {}}
        onCountChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Changes"');
    expect(html).toContain('aria-label="Close changes"');
    expect(html).toContain('aria-label="Refresh changes"');
    expect(html).toContain('aria-label="Changed files"');
  });
});
