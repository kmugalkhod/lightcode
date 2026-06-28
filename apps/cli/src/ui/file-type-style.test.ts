import { describe, expect, it } from "bun:test";
import { cliTheme } from "./cli-theme";
import { fileTypeColor, fileTypeStyle, fileTypeTag } from "./file-type-style";

describe("fileTypeTag", () => {
  it("uppercases the extension, capped at three chars", () => {
    expect(fileTypeTag("src/app.ts")).toBe("TS");
    expect(fileTypeTag("a/b/c.tsx")).toBe("TSX");
    expect(fileTypeTag("data.json")).toBe("JSO");
    expect(fileTypeTag("notes.md")).toBe("MD");
  });

  it("falls back to a bullet when there is no extension", () => {
    expect(fileTypeTag("Makefile")).toBe("•");
    expect(fileTypeTag("src/bin/run")).toBe("•");
  });

  it("uses the trailing segment of a dotfile", () => {
    expect(fileTypeTag(".gitignore")).toBe("GIT");
  });

  it("ignores directory dots when finding the extension", () => {
    expect(fileTypeTag("my.dir/file")).toBe("•");
  });
});

describe("fileTypeColor", () => {
  it("paints TS/TSX with the amber accent", () => {
    expect(fileTypeColor("app.ts")).toBe(cliTheme.accent.primary);
    expect(fileTypeColor("app.tsx")).toBe(cliTheme.accent.primary);
  });

  it("maps JSON to the warning hue and markdown to secondary", () => {
    expect(fileTypeColor("package.json")).toBe(cliTheme.semantic.warning);
    expect(fileTypeColor("README.md")).toBe(cliTheme.text.secondary);
  });

  it("falls back to muted for unknown or extensionless paths", () => {
    expect(fileTypeColor("weird.xyz")).toBe(cliTheme.text.muted);
    expect(fileTypeColor("Makefile")).toBe(cliTheme.text.muted);
  });
});

describe("fileTypeStyle", () => {
  it("bundles tag and color", () => {
    expect(fileTypeStyle("src/index.ts")).toEqual({
      tag: "TS",
      color: cliTheme.accent.primary,
    });
  });
});
