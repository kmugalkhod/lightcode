import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UIMessage } from "ai";
import {
  materializeProviderAttachments,
  storeInlineMessageBlobs,
} from "./attachment-store";

let tempHome: string;
let workspace: string;
const originalLightcodeHome = process.env.LIGHTCODE_HOME;

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

beforeEach(async () => {
  tempHome = await mkdtemp(path.join(tmpdir(), "lightcode-attachments-"));
  workspace = path.join(tempHome, "workspace");
  await mkdir(workspace, { recursive: true });
  process.env.LIGHTCODE_HOME = tempHome;
});

afterEach(async () => {
  if (originalLightcodeHome === undefined) {
    delete process.env.LIGHTCODE_HOME;
  } else {
    process.env.LIGHTCODE_HOME = originalLightcodeHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("attachment store", () => {
  test("materializes a bounded current file ref and compacts it on later turns", async () => {
    await writeFile(path.join(workspace, "source.ts"), "export const value = 1;\n");
    const referenced: UIMessage = {
      id: "u1",
      role: "user",
      parts: [
        {
          type: "data-file-ref",
          data: {
            path: "source.ts",
            contentHash: hash("export const value = 1;\n"),
          },
        },
        { type: "text", text: "Explain this" },
      ],
    };

    const current = await materializeProviderAttachments({
      messages: [referenced],
      cwd: workspace,
    });
    expect(JSON.stringify(current)).toContain("export const value = 1;");
    expect(JSON.stringify(current)).not.toContain("data-file-ref");

    const later = await materializeProviderAttachments({
      messages: [
        referenced,
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
        { id: "u2", role: "user", parts: [{ type: "text", text: "continue" }] },
      ],
      cwd: workspace,
    });
    expect(JSON.stringify(later[0])).toContain("Previously attached file");
    expect(JSON.stringify(later[0])).not.toContain("export const value = 1;");
  });

  test("stores inline images once and rejects symlink escapes", async () => {
    const encoded = Buffer.from("image bytes").toString("base64");
    const stored = await storeInlineMessageBlobs([
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/png",
            filename: "clip.png",
            url: `data:image/png;base64,${encoded}`,
          },
        ],
      },
    ]);
    expect(JSON.stringify(stored)).toContain("data-blob-ref");
    expect(JSON.stringify(stored)).not.toContain(encoded);

    const materialized = await materializeProviderAttachments({
      messages: stored,
      cwd: workspace,
    });
    expect(JSON.stringify(materialized)).toContain(encoded);

    const outsidePath = path.join(tempHome, "outside.txt");
    await writeFile(outsidePath, "secret");
    await symlink(outsidePath, path.join(workspace, "escape.txt"));
    const escaped = await materializeProviderAttachments({
      messages: [
        {
          id: "u2",
          role: "user",
          parts: [
            {
              type: "data-file-ref",
              data: { path: "escape.txt", contentHash: hash("secret") },
            },
          ],
        },
      ],
      cwd: workspace,
    });
    expect(JSON.stringify(escaped)).toContain("Attached file is unavailable");
    expect(JSON.stringify(escaped)).not.toContain("secret");
  });
});
