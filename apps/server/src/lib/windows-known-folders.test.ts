import { afterEach, describe, expect, test } from "bun:test";
import {
  clearWindowsKnownFoldersCache,
  parseWindowsKnownFoldersOutput,
  resolveWindowsKnownFolder,
  resolveWindowsKnownFolders,
  type WindowsKnownFolders,
} from "./windows-known-folders";

const folders: WindowsKnownFolders = {
  desktop: "C:\\Users\\dev\\OneDrive\\Desktop",
  documents: "C:\\Users\\dev\\Documents",
  downloads: "D:\\Downloads",
};

afterEach(() => clearWindowsKnownFoldersCache());

describe("windows known folders", () => {
  test("parses the resolver JSON and drops unusable values", () => {
    expect(
      parseWindowsKnownFoldersOutput(JSON.stringify(folders)),
    ).toEqual(folders);
    expect(
      parseWindowsKnownFoldersOutput(
        JSON.stringify({ desktop: "relative", documents: "", downloads: "C:\\a\nb" }),
      ),
    ).toEqual({ desktop: null, documents: null, downloads: null });
    expect(parseWindowsKnownFoldersOutput("not json")).toBeNull();
    expect(parseWindowsKnownFoldersOutput("{}")).toBeNull();
  });

  test("runs the resolver once per environment and shares the result", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return folders;
    };
    const environment = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\dev" };

    const [first, second] = await Promise.all([
      resolveWindowsKnownFolders(environment, run),
      resolveWindowsKnownFolders(environment, run),
    ]);
    const started = performance.now();
    const desktop = await resolveWindowsKnownFolder(environment, "desktop", { run });
    expect(performance.now() - started).toBeLessThan(50);

    expect(first).toEqual(folders);
    expect(second).toBe(first);
    expect(desktop).toBe(folders.desktop);
    expect(runs).toBe(1);
  });

  test("forgets a failed run so a later request retries", async () => {
    let runs = 0;
    const environment = { SystemRoot: "C:\\Windows" };
    await resolveWindowsKnownFolders(environment, async () => {
      runs += 1;
      return null;
    });
    await resolveWindowsKnownFolders(environment, async () => {
      runs += 1;
      return folders;
    });
    expect(runs).toBe(2);
  });

  test("falls back within the budget while a slow run continues", async () => {
    let finish!: (value: WindowsKnownFolders) => void;
    const slow = () =>
      new Promise<WindowsKnownFolders | null>((resolve) => {
        finish = resolve;
      });
    const environment = { SystemRoot: "C:\\Windows", USERPROFILE: "slow" };

    await expect(
      resolveWindowsKnownFolder(environment, "documents", { budgetMs: 20, run: slow }),
    ).resolves.toBeNull();
    finish(folders);
    await expect(
      resolveWindowsKnownFolder(environment, "documents", { budgetMs: 20, run: slow }),
    ).resolves.toBe(folders.documents);
  });
});
