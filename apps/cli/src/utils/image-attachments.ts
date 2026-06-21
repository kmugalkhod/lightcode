import type { FileUIPart } from "ai";
import type { ClipboardImage } from "./clipboard-image";

/**
 * Pasted images are shown in the input as a short chip (`[Image #1]`) while the
 * real bytes ride along as a separate file part. These helpers are pure so the
 * chip/strip round-trip can be unit-tested without a TUI or clipboard.
 */

/** Matches a rendered image chip and captures its number. */
export const IMAGE_CHIP_PATTERN = /\[Image #(\d+)\]/g;

/** The short label shown in place of a pasted image. */
export function formatImageChip(index: number): string {
  return `[Image #${index}]`;
}

/** Build a data-URL file part the AI SDK can forward to a vision model. */
export function clipboardImageToFilePart(
  index: number,
  image: ClipboardImage,
): FileUIPart {
  return {
    type: "file",
    mediaType: image.mediaType,
    filename: `pasted-image-${index}.png`,
    url: `data:${image.mediaType};base64,${image.base64}`,
  };
}

/**
 * Remove image chips from the text the model receives — the image travels as a
 * file part, so its chip is purely a visual marker. Collapses the double spaces
 * a removed chip can leave behind; trimming of the ends is left to the caller.
 */
export function stripImageChips(text: string): string {
  return text.replace(IMAGE_CHIP_PATTERN, "").replace(/ {2,}/g, " ");
}
