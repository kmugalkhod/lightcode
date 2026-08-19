import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertSessionWorkspaceIdentity,
  createChatSession,
  deleteChatSession,
  persistChatMessages,
  SessionWorkspaceIdentityError,
} from "./chat-store";
import { prisma } from "./prisma-client";

const temporaryDirectories: string[] = [];
const sessionIds: string[] = [];

async function makeWorkspace() {
  const parent = await mkdtemp(path.join(tmpdir(), "lightcode-identity-"));
  temporaryDirectories.push(parent);
  const workspace = path.join(parent, "workspace");
  await mkdir(workspace);
  return { parent, workspace };
}

async function createTrackedSession(workspace: string) {
  const session = await createChatSession({ cwd: workspace });
  sessionIds.push(session.id);
  return session;
}

async function expectIdentityError(
  operation: Promise<unknown>,
  code: SessionWorkspaceIdentityError["code"],
) {
  try {
    await operation;
    throw new Error("Expected workspace identity validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionWorkspaceIdentityError);
    expect((error as SessionWorkspaceIdentityError).code).toBe(code);
  }
}

afterEach(async () => {
  await Promise.all(
    sessionIds.splice(0).map((sessionId) =>
      deleteChatSession(sessionId).catch(() => undefined),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("session workspace identity", () => {
  test("persists and revalidates the canonical directory identity", async () => {
    const { workspace } = await makeWorkspace();
    const session = await createTrackedSession(workspace);

    const row = await prisma.chatSession.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        cwd: true,
        workspaceDevice: true,
        workspaceInode: true,
      },
    });
    expect(row.cwd).toBe(await realpath(workspace));
    expect(row.workspaceDevice).toBeString();
    expect(row.workspaceInode).toBeString();

    await expect(
      assertSessionWorkspaceIdentity(session.id),
    ).resolves.toMatchObject({
      cwd: row.cwd,
      device: row.workspaceDevice,
      inode: row.workspaceInode,
      initializedLegacy: false,
    });
  });

  test("rejects a different real directory placed at the saved path", async () => {
    const { parent, workspace } = await makeWorkspace();
    const session = await createTrackedSession(workspace);
    await rename(workspace, path.join(parent, "original-workspace"));
    await mkdir(workspace);

    await expectIdentityError(
      assertSessionWorkspaceIdentity(session.id),
      "workspace_replaced",
    );
    await expectIdentityError(
      persistChatMessages({
        sessionId: session.id,
        messages: [
          {
            id: "replacement-turn",
            role: "user",
            parts: [{ type: "text", text: "Run a tool" }],
          },
        ],
      }),
      "workspace_replaced",
    );
    const unchanged = await prisma.chatSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { revision: true, _count: { select: { messages: true } } },
    });
    expect(unchanged).toEqual({ revision: 0, _count: { messages: 0 } });
  });

  test.skipIf(process.platform === "win32")(
    "rejects an outside symlink placed at the saved path",
    async () => {
      const { parent, workspace } = await makeWorkspace();
      const outside = path.join(parent, "outside");
      await mkdir(outside);
      const session = await createTrackedSession(workspace);
      await rename(workspace, path.join(parent, "original-workspace"));
      await symlink(outside, workspace, "dir");

      await expectIdentityError(
        assertSessionWorkspaceIdentity(session.id),
        "workspace_replaced",
      );
    },
  );

  test("initializes a legacy identity only for an unchanged canonical root", async () => {
    const { workspace } = await makeWorkspace();
    const session = await createTrackedSession(workspace);
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { workspaceDevice: null, workspaceInode: null },
    });

    const initialized = await assertSessionWorkspaceIdentity(session.id);
    expect(initialized.initializedLegacy).toBe(true);
    const row = await prisma.chatSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { workspaceDevice: true, workspaceInode: true },
    });
    expect(row.workspaceDevice).toBe(initialized.device);
    expect(row.workspaceInode).toBe(initialized.inode);
  });

  test.skipIf(process.platform === "win32")(
    "never initializes a legacy row from a replacement symlink",
    async () => {
      const { parent, workspace } = await makeWorkspace();
      const outside = path.join(parent, "outside");
      await mkdir(outside);
      const session = await createTrackedSession(workspace);
      await prisma.chatSession.update({
        where: { id: session.id },
        data: { workspaceDevice: null, workspaceInode: null },
      });
      await rename(workspace, path.join(parent, "original-workspace"));
      await symlink(outside, workspace, "dir");

      await expectIdentityError(
        assertSessionWorkspaceIdentity(session.id),
        "workspace_replaced",
      );
      const row = await prisma.chatSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { workspaceDevice: true, workspaceInode: true },
      });
      expect(row).toEqual({ workspaceDevice: null, workspaceInode: null });
    },
  );

  test("rejects a grant identity when the directory changed before creation", async () => {
    const { parent, workspace } = await makeWorkspace();
    const before = await lstat(workspace, { bigint: true });
    const expectedWorkspaceIdentity = {
      device:
        before.ino === 0n
          ? "unsupported"
          : before.dev.toString(10),
      inode:
        before.ino === 0n
          ? "unsupported"
          : before.ino.toString(10),
    };
    await rename(workspace, path.join(parent, "original-workspace"));
    await mkdir(workspace);

    await expectIdentityError(
      createChatSession({ cwd: workspace, expectedWorkspaceIdentity }),
      "workspace_replaced",
    );
  });
});
