import { describe, expect, test } from "bun:test";
import {
  borderStyleFor,
  cliTheme,
  getMessageRoleTheme,
  glyphs,
  space,
} from "./cli-theme";

describe("cli-theme design system", () => {
  test("spacing scale is ordered and starts at zero", () => {
    expect(space.none).toBe(0);
    expect(space.xs).toBeLessThanOrEqual(space.md);
    expect(space.md).toBeLessThanOrEqual(space.lg);
  });

  test("border roles map to distinct intents", () => {
    expect(borderStyleFor.card).toBe("rounded");
    expect(borderStyleFor.modal).toBe("heavy");
    expect(borderStyleFor.chrome).toBe("single");
  });

  test("unicode and ascii glyph tables have identical keys", () => {
    expect(Object.keys(glyphs.ascii).sort()).toEqual(
      Object.keys(glyphs.unicode).sort(),
    );
  });

  test("every role has a glyph", () => {
    for (const role of ["user", "assistant", "system"] as const) {
      expect(getMessageRoleTheme(role).glyph.length).toBeGreaterThan(0);
    }
  });

  test("accent is amber and distinct from the warning color", () => {
    expect(cliTheme.accent.primary).toBe("#F2A65A");
    expect(cliTheme.accent.primary).not.toBe(cliTheme.semantic.warning);
    // No teal left as the active accent.
    expect(cliTheme.borders.active).toBe(cliTheme.accent.primary);
    expect(cliTheme.input.focusedBorder).toBe(cliTheme.accent.primary);
  });
});
