import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "./logger";

const originalWrite = process.stderr.write.bind(process.stderr);
const originalLevel = process.env.LIGHTCODE_LOG_LEVEL;

function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    run();
  } finally {
    process.stderr.write = originalWrite;
  }

  return lines;
}

afterEach(() => {
  process.stderr.write = originalWrite;
  if (originalLevel === undefined) {
    delete process.env.LIGHTCODE_LOG_LEVEL;
  } else {
    process.env.LIGHTCODE_LOG_LEVEL = originalLevel;
  }
});

describe("createLogger", () => {
  test("writes structured JSON lines to stderr", () => {
    delete process.env.LIGHTCODE_LOG_LEVEL;
    const logger = createLogger("test");

    const lines = captureStderr(() => {
      logger.info("something_happened", { sessionId: "abc" });
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.logger).toBe("test");
    expect(parsed.event).toBe("something_happened");
    expect(parsed.sessionId).toBe("abc");
    expect(typeof parsed.ts).toBe("string");
  });

  test("filters below the configured level", () => {
    process.env.LIGHTCODE_LOG_LEVEL = "warn";
    const logger = createLogger("test");

    const lines = captureStderr(() => {
      logger.debug("hidden");
      logger.info("hidden too");
      logger.warn("visible");
      logger.error("also visible");
    });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe("visible");
    expect(JSON.parse(lines[1]).event).toBe("also visible");
  });
});
