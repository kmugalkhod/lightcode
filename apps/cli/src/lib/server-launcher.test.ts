import { describe, expect, test } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  existingLightcodeInterfaceError,
  resolveServerEntryFromModuleUrl,
} from "./server-launcher";

describe("existingLightcodeInterfaceError", () => {
  test("explains a terminal-first conflict when browser mode starts", () => {
    expect(existingLightcodeInterfaceError("browser", 4983)).toBe(
      "A Lightcode terminal interface is already running on port 4983. " +
        "Stop it before starting the browser interface. " +
        "This release supports one Lightcode interface at a time.",
    );
  });

  test("explains a browser-first conflict when terminal mode starts", () => {
    expect(existingLightcodeInterfaceError("terminal", "4983")).toBe(
      "A Lightcode browser interface is already running on port 4983. " +
        "Stop it before starting the terminal interface. " +
        "This release supports one Lightcode interface at a time.",
    );
  });
});

describe("resolveServerEntryFromModuleUrl", () => {
  test("uses the adjacent bundled server in a published package", () => {
    const packageDirectory = path.resolve(
      "fixture-published",
      "node_modules",
      "@kmugalkhod",
      "lightcode",
    );
    const moduleUrl = pathToFileURL(path.join(packageDirectory, "cli.js")).toString();
    const expectedServer = path.join(packageDirectory, "server.js");
    expect(
      resolveServerEntryFromModuleUrl(
        moduleUrl,
        (candidate) => candidate === expectedServer,
      ),
    ).toBe(expectedServer);
  });

  test("uses the monorepo server only from the recognized source layout", () => {
    const repository = path.resolve("fixture-repository");
    const moduleUrl = pathToFileURL(
      path.join(repository, "apps", "cli", "src", "lib", "server-launcher.ts"),
    ).toString();
    const expectedServer = path.join(repository, "apps", "server", "src", "index.ts");
    expect(
      resolveServerEntryFromModuleUrl(
        moduleUrl,
        (candidate) => candidate === expectedServer,
      ),
    ).toBe(expectedServer);
  });

  test("fails closed instead of executing a consuming project's server", () => {
    const packageDirectory = path.resolve(
      "fixture-consumer",
      "node_modules",
      "@kmugalkhod",
      "lightcode",
    );
    const moduleUrl = pathToFileURL(path.join(packageDirectory, "cli.js")).toString();
    const unrelatedServer = path.resolve("fixture-consumer", "server", "src", "index.ts");
    expect(
      resolveServerEntryFromModuleUrl(
        moduleUrl,
        (candidate) => candidate === unrelatedServer,
      ),
    ).toBeNull();
  });
});
