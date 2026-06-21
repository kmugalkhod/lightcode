import { describe, expect, test } from "bun:test";
import {
  clipboardImageToFilePart,
  formatImageChip,
  stripImageChips,
} from "./image-attachments";

describe("formatImageChip", () => {
  test("renders a numbered chip", () => {
    expect(formatImageChip(2)).toBe("[Image #2]");
  });
});

describe("clipboardImageToFilePart", () => {
  test("builds a data-URL file part from clipboard bytes", () => {
    const part = clipboardImageToFilePart(1, {
      mediaType: "image/png",
      base64: "QUJD",
      byteLength: 3,
    });
    expect(part).toEqual({
      type: "file",
      mediaType: "image/png",
      filename: "pasted-image-1.png",
      url: "data:image/png;base64,QUJD",
    });
  });
});

describe("stripImageChips", () => {
  test("removes chips and collapses the resulting double space", () => {
    expect(stripImageChips("look at [Image #1] please")).toBe("look at please");
  });

  test("removes multiple chips", () => {
    expect(stripImageChips("[Image #1] and [Image #2]")).toBe(" and ");
  });

  test("leaves chip-free text untouched", () => {
    expect(stripImageChips("just text")).toBe("just text");
  });
});
