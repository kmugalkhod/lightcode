import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import {
  buildWebAppUrl,
  createWebBootstrapFile,
  getBrowserOpenCommand,
} from "./web-launcher";

describe("buildWebAppUrl", () => {
  test("keeps the browser token in the fragment", () => {
    const url = new URL(buildWebAppUrl("http://127.0.0.1:4983", "a+b/c"));
    expect(url.origin).toBe("http://127.0.0.1:4983");
    expect(url.pathname).toBe("/app/");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe("a+b/c");
  });
});

describe("createWebBootstrapFile", () => {
  test("keeps the bearer in a private redirect file instead of the opener argv", () => {
    const authenticatedUrl =
      "http://127.0.0.1:4983/app/#token=private-browser-token";
    const bootstrap = createWebBootstrapFile(authenticatedUrl);
    try {
      expect(bootstrap.fileUrl).toStartWith("file://");
      expect(bootstrap.fileUrl).not.toContain("private-browser-token");
      expect(readFileSync(bootstrap.filePath, "utf8")).toContain(
        authenticatedUrl,
      );
      if (process.platform !== "win32") {
        expect(statSync(bootstrap.filePath).mode & 0o077).toBe(0);
      }
    } finally {
      bootstrap.cleanup();
    }
  });
});

describe("getBrowserOpenCommand", () => {
  const url = "http://127.0.0.1:4983/app#token=test";

  test("uses the native macOS opener", () => {
    expect(getBrowserOpenCommand(url, "darwin")).toEqual(["open", url]);
  });

  test("uses Windows ShellExecute without cmd.exe", () => {
    expect(getBrowserOpenCommand(url, "win32")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      url,
    ]);
  });

  test("keeps Windows path metacharacters inside one non-shell argument", () => {
    const fileUrl = "file:///C:/Users/A%26B/AppData/Temp/lightcode%5E/open.html";
    expect(getBrowserOpenCommand(fileUrl, "win32")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      fileUrl,
    ]);
  });

  test("uses xdg-open on Linux", () => {
    expect(getBrowserOpenCommand(url, "linux")).toEqual(["xdg-open", url]);
  });
});
