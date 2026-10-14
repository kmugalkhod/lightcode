import { describe, expect, test } from "bun:test";
import {
  isHiddenBrowserEntry,
  isOmittedFromFolderListing,
} from "./workspace-entry-filter";

function entry(name: string, kind: "file" | "directory" | "link") {
  return {
    name,
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "link",
  };
}

describe("browser entry filter", () => {
  test("hides dot entries on every platform", () => {
    expect(isHiddenBrowserEntry(entry(".git", "directory"), "linux")).toBe(true);
    expect(isHiddenBrowserEntry(entry(".env", "file"), "win32")).toBe(true);
    expect(isHiddenBrowserEntry(entry("src", "directory"), "darwin")).toBe(false);
  });

  test("hides Windows registry hives and shell metadata", () => {
    for (const name of [
      "NTUSER.DAT",
      "ntuser.dat.LOG1",
      "NTUSER.DAT{309b0bec-d4e7-11f0-84bc-afe8fc2fa2a4}.TM.blf",
      "ntuser.ini",
      "desktop.ini",
      "Thumbs.db",
      "$Recycle.Bin",
      "System Volume Information",
      "pagefile.sys",
    ]) {
      expect(isHiddenBrowserEntry(entry(name, "file"), "win32")).toBe(true);
    }
    expect(isHiddenBrowserEntry(entry("NTUSER.DAT", "file"), "linux")).toBe(false);
    expect(isHiddenBrowserEntry(entry("ntuserdata", "directory"), "win32")).toBe(false);
  });

  test("hides legacy profile junctions but not real folders or OneDrive", () => {
    for (const name of ["Cookies", "My Documents", "Application Data", "Start Menu"]) {
      expect(isHiddenBrowserEntry(entry(name, "link"), "win32")).toBe(true);
      expect(isHiddenBrowserEntry(entry(name, "directory"), "win32")).toBe(false);
    }
    // OneDrive is a reparse point too, and it holds real projects.
    expect(isHiddenBrowserEntry(entry("OneDrive", "link"), "win32")).toBe(false);
    expect(isHiddenBrowserEntry(entry("Cookies", "link"), "darwin")).toBe(false);
  });

  test("folder-only listings drop plain files and keep links", () => {
    expect(isOmittedFromFolderListing(entry("notes.txt", "file"))).toBe(true);
    expect(isOmittedFromFolderListing(entry("src", "directory"))).toBe(false);
    expect(isOmittedFromFolderListing(entry("OneDrive", "link"))).toBe(false);
  });
});
