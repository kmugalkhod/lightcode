import { glyphs, type GlyphName } from "./cli-theme";

/**
 * Terminal capability detection. Keeps the TUI legible across NO_COLOR,
 * non-truecolor, non-UTF-8, and reduced-motion environments. Pure over an env
 * map so it can be unit-tested.
 */
export interface TerminalCapabilities {
  /** Color output is allowed (false under NO_COLOR). */
  color: boolean;
  /** Terminal can render the Unicode glyph set (UTF-8 locale). */
  unicode: boolean;
  /** Animation should be held static. */
  reducedMotion: boolean;
}

type Env = Record<string, string | undefined>;

function isUtf8Locale(env: Env): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (!locale) {
    // No locale info: assume modern UTF-8 terminal rather than cripple the UI.
    return true;
  }
  return /utf-?8/i.test(locale);
}

export function detectTerminalCapabilities(
  env: Env = process.env,
): TerminalCapabilities {
  const noColor = Boolean(env.NO_COLOR);
  const dumbTerm = env.TERM === "dumb";
  return {
    color: !noColor && !dumbTerm,
    unicode: isUtf8Locale(env),
    reducedMotion: Boolean(env.NO_COLOR || env.LIGHTCODE_REDUCED_MOTION),
  };
}

/** The glyph table for a capability set (Unicode when supported, else ASCII). */
export function resolveGlyphs(
  caps: TerminalCapabilities,
): Record<GlyphName, string> {
  return caps.unicode ? glyphs.unicode : glyphs.ascii;
}

/** Capabilities detected once at startup from the real environment. */
export const terminalCapabilities = detectTerminalCapabilities();

/** Active glyph table — import this in components instead of `glyphs.unicode`. */
export const activeGlyphs = resolveGlyphs(terminalCapabilities);
