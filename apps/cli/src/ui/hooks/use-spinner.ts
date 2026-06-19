import { useEffect, useState } from "react";

/**
 * Braille spinner frames — a single cell that morphs in place, so swapping it
 * can never shift the surrounding layout (the one safe "motion" in a TUI).
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const ASCII_SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;
const STATIC_GLYPH = "●";
const FRAME_INTERVAL_MS = 100;

export interface SpinnerOptions {
  /** Advance frames only while true (e.g. while streaming). */
  active: boolean;
  /** Hold a static glyph instead of animating (NO_COLOR / reduced motion). */
  reducedMotion?: boolean;
  /** Use ASCII frames for non-UTF-8 terminals. */
  ascii?: boolean;
}

/**
 * Pure frame resolution — the glyph for a given tick. Extracted from the hook so
 * it can be unit-tested without a renderer.
 */
export function spinnerGlyph(
  tick: number,
  { active, reducedMotion = false, ascii = false }: SpinnerOptions,
): string {
  if (reducedMotion || !active) {
    return STATIC_GLYPH;
  }
  const frames = ascii ? ASCII_SPINNER_FRAMES : SPINNER_FRAMES;
  const index = ((tick % frames.length) + frames.length) % frames.length;
  return frames[index];
}

/**
 * Returns the current spinner glyph. When inactive or reduced-motion, returns a
 * stable glyph and runs no timer.
 */
export function useSpinner(options: SpinnerOptions): string {
  const { active, reducedMotion = false } = options;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active || reducedMotion) {
      return;
    }

    const intervalId = setInterval(() => {
      setTick((current) => current + 1);
    }, FRAME_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [active, reducedMotion]);

  return spinnerGlyph(tick, options);
}

export const __spinnerInternals = {
  SPINNER_FRAMES,
  ASCII_SPINNER_FRAMES,
  STATIC_GLYPH,
};
