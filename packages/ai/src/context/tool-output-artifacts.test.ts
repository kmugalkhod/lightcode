import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelMessage, ToolResultPart } from "ai";
import {
  artifactizeLargeToolOutputs,
  getToolOutputArtifactPath,
  readToolOutputArtifact,
  serializeToolResultOutput,
  toolOutputArtifactExists,
} from "./tool-output-artifacts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempDataDir(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lightcode-tool-artifacts-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function toolResultMessage(
  output: ToolResultPart["output"],
  toolCallId = "call-1",
): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId,
        toolName: "bash",
        output,
      },
    ],
  };
}

function resultOutput(message: ModelMessage): ToolResultPart["output"] {
  if (!Array.isArray(message.content)) {
    throw new Error("Expected multipart message content.");
  }
  const part = message.content[0];
  if (part.type !== "tool-result") {
    throw new Error("Expected tool-result part.");
  }
  return part.output;
}

describe("tool-output artifacts", () => {
  test("stores the complete output while returning a bounded head/tail provider preview", async () => {
    const dataDir = await tempDataDir();
    const output: ToolResultPart["output"] = {
      type: "text",
      value: `HEAD-${"é".repeat(4_000)}-TAIL`,
    };
    const message = toolResultMessage(output);
    const canonicalSnapshot = structuredClone(message);

    const result = await artifactizeLargeToolOutputs([message], {
      dataDir,
      thresholdCharacters: 100,
      previewCharacters: 800,
    });

    expect(message).toEqual(canonicalSnapshot);
    expect(result.messages[0]).not.toBe(message);
    expect(result.artifactizedOutputs).toBe(1);
    expect(result.artifacts).toHaveLength(1);
    expect(result.savedCharacters).toBeGreaterThan(0);

    const reference = result.artifacts[0];
    expect(reference.byteSize).toBeGreaterThan(reference.characterSize);
    const providerOutput = resultOutput(result.messages[0]);
    expect(providerOutput.type).toBe("text");
    if (providerOutput.type !== "text") {
      throw new Error("Expected artifact text preview.");
    }
    expect(providerOutput.value.length).toBeLessThanOrEqual(800);
    expect(providerOutput.value).toContain(`handle: ${reference.handle}`);
    expect(providerOutput.value).toContain(`sha256: ${reference.digest}`);
    expect(providerOutput.value).toContain(
      `stored-json-bytes: ${reference.byteSize}`,
    );
    expect(providerOutput.value).toContain(
      `stored-json-characters: ${reference.characterSize}`,
    );
    expect(providerOutput.value).toContain("HEAD-");
    expect(providerOutput.value).toContain("-TAIL");
    expect(providerOutput.value).toContain("characters omitted");

    const artifactPath = getToolOutputArtifactPath(reference.handle, dataDir);
    expect(await readFile(artifactPath, "utf8")).toBe(
      serializeToolResultOutput(output),
    );
    expect(await readToolOutputArtifact(reference.handle, { dataDir })).toEqual(
      output,
    );
    expect(await toolOutputArtifactExists(reference.handle, dataDir)).toBe(true);
  });

  test("is idempotent across repeated requests and does not rewrite an artifact", async () => {
    const dataDir = await tempDataDir();
    const message = toolResultMessage({
      type: "json",
      value: { rows: Array.from({ length: 50 }, (_, index) => ({ index })) },
    });
    const options = {
      dataDir,
      thresholdCharacters: 10,
      previewCharacters: 700,
    };

    const first = await artifactizeLargeToolOutputs([message], options);
    const artifactPath = getToolOutputArtifactPath(
      first.artifacts[0].handle,
      dataDir,
    );
    const firstStat = await stat(artifactPath);
    const second = await artifactizeLargeToolOutputs([message], options);
    const secondStat = await stat(artifactPath);

    expect(second.artifacts[0]).toEqual(first.artifacts[0]);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);

    const alreadyPreviewed = await artifactizeLargeToolOutputs(
      second.messages,
      { ...options, thresholdCharacters: 0 },
    );
    expect(alreadyPreviewed.artifactizedOutputs).toBe(0);
    expect(alreadyPreviewed.messages[0]).toBe(second.messages[0]);
  });

  test("canonicalizes JSON object keys so equivalent outputs share an address", async () => {
    const dataDir = await tempDataDir();
    const firstOutput: ToolResultPart["output"] = {
      type: "json",
      value: { zebra: 2, alpha: { right: true, left: false } },
    };
    const secondOutput: ToolResultPart["output"] = {
      value: { alpha: { left: false, right: true }, zebra: 2 },
      type: "json",
    };

    const first = await artifactizeLargeToolOutputs(
      [toolResultMessage(firstOutput, "first")],
      { dataDir, thresholdCharacters: 0, previewCharacters: 700 },
    );
    const second = await artifactizeLargeToolOutputs(
      [toolResultMessage(secondOutput, "second")],
      { dataDir, thresholdCharacters: 0, previewCharacters: 700 },
    );

    expect(second.artifacts[0].digest).toBe(first.artifacts[0].digest);
    expect(serializeToolResultOutput(secondOutput)).toBe(
      serializeToolResultOutput(firstOutput),
    );
  });

  test("leaves small outputs and message identities untouched", async () => {
    const dataDir = await tempDataDir();
    const user: ModelMessage = { role: "user", content: "Keep this exact." };
    const toolMessage = toolResultMessage({ type: "text", value: "small" });

    const result = await artifactizeLargeToolOutputs([user, toolMessage], {
      dataDir,
      thresholdCharacters: 1_000,
    });

    expect(result.messages).toEqual([user, toolMessage]);
    expect(result.messages[0]).toBe(user);
    expect(result.messages[1]).toBe(toolMessage);
    expect(result.artifacts).toEqual([]);
    expect(result.artifactizedOutputs).toBe(0);
    expect(result.savedCharacters).toBe(0);
  });

  test("deduplicates identical outputs within one provider request", async () => {
    const dataDir = await tempDataDir();
    const output: ToolResultPart["output"] = {
      type: "error-text",
      value: `failure:${"!".repeat(2_000)}`,
    };

    const result = await artifactizeLargeToolOutputs(
      [toolResultMessage(output, "one"), toolResultMessage(output, "two")],
      { dataDir, thresholdCharacters: 10, previewCharacters: 700 },
    );

    expect(result.artifactizedOutputs).toBe(2);
    expect(result.artifacts).toHaveLength(1);
    expect(resultOutput(result.messages[0])).toEqual(
      resultOutput(result.messages[1]),
    );
  });
});
