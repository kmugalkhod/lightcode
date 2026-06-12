import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { getLightcodeDataDir } from "./data-dir";

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

const maxLogFilesKept = 5;
const logFilePattern = /^server-\d{4}-\d{2}-\d{2}\.log$/;

let fileSinkPrefix: string | null = null;
let fileSinkState: { date: string; filePath: string } | null = null;

export function getLogDirectory(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(getLightcodeDataDir(env), "logs");
}

function currentDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function pruneOldLogFiles(directory: string) {
  try {
    const logFiles = readdirSync(directory)
      .filter((name) => logFilePattern.test(name))
      .sort();

    for (const name of logFiles.slice(0, -maxLogFilesKept)) {
      unlinkSync(path.join(directory, name));
    }
  } catch {
    // Pruning failures must never break logging.
  }
}

/**
 * Enables an additional JSONL file sink for every logger in this process.
 * Files rotate daily (server-YYYY-MM-DD.log) and the newest five are kept.
 * Intended for the server process — the source of truth when debugging
 * provider failures whose messages were truncated for the client.
 */
export function enableFileLogSink(
  env: Record<string, string | undefined> = process.env,
): string | null {
  try {
    const directory = getLogDirectory(env);
    mkdirSync(directory, { recursive: true });
    fileSinkPrefix = directory;
    pruneOldLogFiles(directory);
    return directory;
  } catch {
    fileSinkPrefix = null;
    return null;
  }
}

export function getActiveLogFilePath(): string | null {
  if (!fileSinkPrefix) {
    return null;
  }

  const filePath = path.join(
    fileSinkPrefix,
    `server-${currentDateStamp()}.log`,
  );
  return existsSync(filePath) || fileSinkState?.filePath === filePath
    ? filePath
    : fileSinkState?.filePath ?? filePath;
}

function writeToFileSink(line: string) {
  if (!fileSinkPrefix) {
    return;
  }

  try {
    const date = currentDateStamp();
    if (!fileSinkState || fileSinkState.date !== date) {
      fileSinkState = {
        date,
        filePath: path.join(fileSinkPrefix, `server-${date}.log`),
      };
      pruneOldLogFiles(fileSinkPrefix);
    }

    appendFileSync(fileSinkState.filePath, `${line}\n`);
  } catch {
    // The stderr sink already has the line; never throw from logging.
  }
}

/**
 * Structured JSON-lines logger. Writes to stderr — stdout belongs to the TUI
 * renderer, so anything written there corrupts the interface. When the file
 * sink is enabled (server process), lines are also appended to a daily log
 * file under the Lightcode data directory.
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
    writeToFileSink(line);
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
