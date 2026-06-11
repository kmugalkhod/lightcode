export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveConfiguredLevel(): LogLevel {
  const raw = process.env.LIGHTCODE_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }

  return "info";
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured JSON-lines logger. Writes to stderr — stdout belongs to the TUI
 * renderer, so anything written there corrupts the interface.
 */
export function createLogger(name: string): Logger {
  const write = (
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>,
  ) => {
    if (levelOrder[level] < levelOrder[resolveConfiguredLevel()]) {
      return;
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      logger: name,
      event,
      ...fields,
    });
    process.stderr.write(`${line}\n`);
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
