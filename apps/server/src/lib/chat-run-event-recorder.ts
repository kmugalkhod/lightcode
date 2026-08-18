import { appendChatRunEvent } from "./chat-run-store";

export interface OrderedRunEvent {
  kind: string;
  payload: unknown;
}

export type RunToolEventKind =
  | "tool_call_started"
  | "tool_call_result"
  | "tool_call_error";

/**
 * Tool lifecycle payloads intentionally remain open-ended. The agent owns the
 * tool-specific input/output shape, while the recorder owns only durable
 * ordering and the semantic event kind.
 */
export type RunToolEvent = {
  kind: RunToolEventKind;
  [key: string]: unknown;
};

export type AppendRunEvent = (event: {
  runId: string;
  cursor: number;
  kind: string;
  payload: unknown;
}) => Promise<void>;

export class RunEventRecorderConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly sessionId: string,
    readonly activeRunId?: string,
  ) {
    super(
      activeRunId
        ? `Session ${sessionId} already has a run event recorder for ${activeRunId}.`
        : `Run ${runId} already has an event recorder.`,
    );
    this.name = "RunEventRecorderConflictError";
  }
}

export class RunEventRecorderNotFoundError extends Error {
  constructor(readonly subject: string) {
    super(`No active run event recorder exists for ${subject}.`);
    this.name = "RunEventRecorderNotFoundError";
  }
}

/**
 * Allocates cursors synchronously and persists events one at a time. A failed
 * append poisons the chain: later records and drain() reject with the same
 * failure instead of writing events beyond a durability gap.
 */
export class OrderedRunEventRecorder {
  readonly runId: string;
  readonly sessionId: string;

  private nextCursorValue: number;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly appendEvent: AppendRunEvent;

  constructor({
    sessionId,
    runId,
    startCursor = 0,
    appendEvent = appendChatRunEvent,
  }: {
    sessionId: string;
    runId: string;
    startCursor?: number;
    appendEvent?: AppendRunEvent;
  }) {
    if (!sessionId) {
      throw new Error("A session id is required for a run event recorder.");
    }
    if (!runId) {
      throw new Error("A run id is required for a run event recorder.");
    }
    if (!Number.isSafeInteger(startCursor) || startCursor < 0) {
      throw new Error(
        "Run event recorder startCursor must be a non-negative safe integer.",
      );
    }

    this.sessionId = sessionId;
    this.runId = runId;
    this.nextCursorValue = startCursor;
    this.appendEvent = appendEvent;
  }

  get nextCursor(): number {
    return this.nextCursorValue;
  }

  record(kind: string, payload: unknown): Promise<number>;
  record(event: OrderedRunEvent): Promise<number>;
  record(
    kindOrEvent: string | OrderedRunEvent,
    payload?: unknown,
  ): Promise<number> {
    const event =
      typeof kindOrEvent === "string"
        ? { kind: kindOrEvent, payload }
        : kindOrEvent;
    if (!event.kind) {
      return Promise.reject(new Error("A run event kind is required."));
    }

    const cursor = this.nextCursorValue;
    this.nextCursorValue += 1;

    const write = this.writeTail.then(async () => {
      await this.appendEvent({
        runId: this.runId,
        cursor,
        kind: event.kind,
        payload: event.payload,
      });
      return cursor;
    });

    this.writeTail = write.then(() => undefined);
    // Keep the internal rejected tail observed while preserving its rejection
    // for drain() and all subsequently queued writes.
    void this.writeTail.catch(() => undefined);
    return write;
  }

  drain(): Promise<void> {
    return this.writeTail;
  }
}

const recordersByRunId = new Map<string, OrderedRunEventRecorder>();
const activeRecordersBySessionId = new Map<string, OrderedRunEventRecorder>();

/** Creates and atomically registers the sole recorder for a run/session. */
export function createOrderedRunEventRecorder(options: {
  sessionId: string;
  runId: string;
  startCursor?: number;
  appendEvent?: AppendRunEvent;
}): OrderedRunEventRecorder {
  const existingForRun = recordersByRunId.get(options.runId);
  if (existingForRun) {
    throw new RunEventRecorderConflictError(
      options.runId,
      options.sessionId,
    );
  }

  const existingForSession = activeRecordersBySessionId.get(
    options.sessionId,
  );
  if (existingForSession) {
    throw new RunEventRecorderConflictError(
      options.runId,
      options.sessionId,
      existingForSession.runId,
    );
  }

  const recorder = new OrderedRunEventRecorder(options);
  recordersByRunId.set(recorder.runId, recorder);
  activeRecordersBySessionId.set(recorder.sessionId, recorder);
  return recorder;
}

export function getOrderedRunEventRecorder(
  runId: string,
): OrderedRunEventRecorder | null {
  return recordersByRunId.get(runId) ?? null;
}

export function getActiveRunEventRecorder(
  sessionId: string,
): OrderedRunEventRecorder | null {
  return activeRecordersBySessionId.get(sessionId) ?? null;
}

/**
 * Identity-checked cleanup ensures a late finalizer cannot remove a newer
 * recorder that happens to use the same session or run id.
 */
export function releaseOrderedRunEventRecorder(
  recorder: OrderedRunEventRecorder,
): boolean {
  if (recordersByRunId.get(recorder.runId) !== recorder) {
    return false;
  }

  recordersByRunId.delete(recorder.runId);
  if (activeRecordersBySessionId.get(recorder.sessionId) === recorder) {
    activeRecordersBySessionId.delete(recorder.sessionId);
  }
  return true;
}

export function recordRunEventById(
  runId: string,
  event: OrderedRunEvent,
): Promise<number> {
  const recorder = getOrderedRunEventRecorder(runId);
  if (!recorder) {
    return Promise.reject(new RunEventRecorderNotFoundError(`run ${runId}`));
  }
  return recorder.record(event);
}

function splitToolEvent(event: RunToolEvent): OrderedRunEvent {
  const { kind, ...payload } = event;
  return { kind, payload };
}

/** Records a semantic tool lifecycle event when the caller already has runId. */
export function recordRunToolEvent(
  runId: string,
  event: RunToolEvent,
): Promise<number> {
  return recordRunEventById(runId, splitToolEvent(event));
}

/** Records a semantic tool lifecycle event from session-scoped tool context. */
export function recordActiveRunToolEvent(
  sessionId: string,
  event: RunToolEvent,
): Promise<number> {
  const recorder = getActiveRunEventRecorder(sessionId);
  if (!recorder) {
    return Promise.reject(
      new RunEventRecorderNotFoundError(`session ${sessionId}`),
    );
  }
  return recorder.record(splitToolEvent(event));
}
