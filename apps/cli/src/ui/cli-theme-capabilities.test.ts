import { describe, expect, test } from "bun:test";
import { glyphs } from "./cli-theme";
import {
  detectTerminalCapabilities,
  resolveGlyphs,
} from "./cli-theme-capabilities";

describe("detectTerminalCapabilities", () => {
  test("defaults to color + unicode + motion on a modern terminal", () => {
    const caps = detectTerminalCapabilities({ LANG: "en_US.UTF-8", TERM: "xterm-256color" });
    expect(caps).toEqual({ color: true, unicode: true, reducedMotion: false });
  });

  test("NO_COLOR disables color and motion", () => {
    const caps = detectTerminalCapabilities({ NO_COLOR: "1", LANG: "en_US.UTF-8" });
    expect(caps.color).toBe(false);
    expect(caps.reducedMotion).toBe(true);
  });

  test("non-UTF-8 locale disables unicode glyphs", () => {
    const caps = detectTerminalCapabilities({ LC_ALL: "C", TERM: "xterm" });
    expect(caps.unicode).toBe(false);
  });

  test("explicit reduced-motion flag is honored", () => {
    const caps = detectTerminalCapabilities({ LIGHTCODE_REDUCED_MOTION: "1", LANG: "C.UTF-8" });
    expect(caps.reducedMotion).toBe(true);
    expect(caps.unicode).toBe(true);
  });

  test("dumb terminal disables color", () => {
    expect(detectTerminalCapabilities({ TERM: "dumb" }).color).toBe(false);
  });
});

describe("resolveGlyphs", () => {
  test("returns the unicode table when unicode is supported", () => {
    expect(
      resolveGlyphs({ color: true, unicode: true, reducedMotion: false }),
    ).toBe(glyphs.unicode);
  });

  test("returns the ascii table when unicode is unsupported", () => {
    expect(
      resolveGlyphs({ color: true, unicode: false, reducedMotion: false }),
    ).toBe(glyphs.ascii);
  });
});
