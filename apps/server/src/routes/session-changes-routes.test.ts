import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canCreateFileSymlinks } from "@lightcode/shared/testing";
import { createSessionChangesRoutes } from "./session-changes-routes";

const directories: string[] = [];
const sessionId = "11111111-1111-4111-8111-111111111111";

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
  }
}

async function makeRepo() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "lightcode-changes-")));
  directories.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await git(root, "config", "core.autocrlf", "false");
  await writeFile(path.join(root, "app.ts"), "one\ntwo\nthree\n");
  await writeFile(path.join(root, "gone.ts"), "remove me\n");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "init");
  return root;
}

function routesFor(workspace: string) {
  return createSessionChangesRoutes({
    resolveSessionWorkspace: async () => workspace,
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("session changes routes", () => {
  test("lists changed files with kinds and line counts, then serves diffs by id", async () => {
    const root = await makeRepo();
    await writeFile(path.join(root, "app.ts"), "one\nTWO\nthree\nfour\n");
    await unlink(path.join(root, "gone.ts"));
    await writeFile(path.join(root, "staged.ts"), "new\nfile\n");
    await git(root, "add", "staged.ts");
    await writeFile(path.join(root, "notes.md"), "draft\n");
    const app = routesFor(root);

    const response = await app.request(`/${sessionId}/changes`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      isRepo: boolean;
      files: Array<{
        fileId: string;
        path: string;
        changeKind: string;
        added: number | null;
        removed: number | null;
      }>;
    };
    expect(body.isRepo).toBe(true);
    const byPath = new Map(body.files.map((file) => [file.path, file]));
    expect(byPath.get("app.ts")).toMatchObject({ changeKind: "modified", added: 2, removed: 1 });
    expect(byPath.get("gone.ts")).toMatchObject({ changeKind: "deleted", added: 0, removed: 1 });
    expect(byPath.get("staged.ts")).toMatchObject({ changeKind: "created", added: 2, removed: 0 });
    expect(byPath.get("notes.md")).toMatchObject({ changeKind: "untracked" });
    for (const file of body.files) {
      expect(file.fileId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(file.fileId).not.toContain(file.path);
    }

    const modified = await app.request(
      `/${sessionId}/changes/${byPath.get("app.ts")?.fileId}/diff`,
    );
    const modifiedDiff = (await modified.json()) as { diff: string };
    expect(modifiedDiff.diff).toContain("-two");
    expect(modifiedDiff.diff).toContain("+TWO");

    const staged = await app.request(
      `/${sessionId}/changes/${byPath.get("staged.ts")?.fileId}/diff`,
    );
    expect(((await staged.json()) as { diff: string }).diff).toContain("+new");

    const untracked = await app.request(
      `/${sessionId}/changes/${byPath.get("notes.md")?.fileId}/diff`,
    );
    expect(await untracked.json()).toMatchObject({
      path: "notes.md",
      diff: "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,1 @@\n+draft",
      binary: false,
    });
  }, 30_000);

  test("rejects unknown and malformed file ids", async () => {
    const root = await makeRepo();
    const app = routesFor(root);
    const unknown = await app.request(`/${sessionId}/changes/${"A".repeat(22)}/diff`);
    expect(unknown.status).toBe(404);
    const malformed = await app.request(
      `/${sessionId}/changes/${encodeURIComponent("../app.ts")}/diff`,
    );
    expect(malformed.status).toBe(400);
  });

  test("reports a folder that is not a git repository", async () => {
    const folder = await realpath(await mkdtemp(path.join(tmpdir(), "lightcode-norepo-")));
    directories.push(folder);
    const response = await routesFor(folder).request(`/${sessionId}/changes`);
    expect(await response.json()).toEqual({
      isRepo: false,
      branch: null,
      files: [],
      truncated: false,
    });
  });

  test.skipIf(!canCreateFileSymlinks)(
    "never follows an untracked symlink out of the workspace",
    async () => {
      const root = await makeRepo();
      const outside = await realpath(await mkdtemp(path.join(tmpdir(), "lightcode-outside-")));
      directories.push(outside);
      await writeFile(path.join(outside, "secret.txt"), "secret\n");
      await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
      const app = routesFor(root);
      const { files } = (await (await app.request(`/${sessionId}/changes`)).json()) as {
        files: Array<{ fileId: string; path: string }>;
      };
      const link = files.find((file) => file.path === "link.txt");
      const response = await app.request(`/${sessionId}/changes/${link?.fileId}/diff`);
      expect(JSON.stringify(await response.json())).not.toContain("secret");
    },
  );
});
