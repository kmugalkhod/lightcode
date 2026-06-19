import { describe, expect, test } from "bun:test";
import { __spinnerInternals, spinnerGlyph } from "./use-spinner";

const { SPINNER_FRAMES, ASCII_SPINNER_FRAMES, STATIC_GLYPH } = __spinnerInternals;

describe("spinnerGlyph", () => {
  test("advances through frames while active", () => {
    expect(spinnerGlyph(0, { active: true })).toBe(SPINNER_FRAMES[0]);
    expect(spinnerGlyph(1, { active: true })).toBe(SPINNER_FRAMES[1]);
    // Wraps around.
    expect(spinnerGlyph(SPINNER_FRAMES.length, { active: true })).toBe(
      SPINNER_FRAMES[0],
    );
  });

  test("returns a static glyph when inactive", () => {
    expect(spinnerGlyph(3, { active: false })).toBe(STATIC_GLYPH);
  });

  test("returns a static glyph under reduced motion even when active", () => {
    expect(spinnerGlyph(3, { active: true, reducedMotion: true })).toBe(
      STATIC_GLYPH,
    );
  });

  test("uses ASCII frames when requested", () => {
    expect(spinnerGlyph(1, { active: true, ascii: true })).toBe(
      ASCII_SPINNER_FRAMES[1],
    );
  });

  test("handles negative ticks safely", () => {
    expect(typeof spinnerGlyph(-1, { active: true })).toBe("string");
    expect(spinnerGlyph(-1, { active: true }).length).toBeGreaterThan(0);
  });
});
