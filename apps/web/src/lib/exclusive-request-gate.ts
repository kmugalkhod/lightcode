export interface ExclusiveRequestGate {
  tryStart(): number | null;
  isBusy(): boolean;
  isCurrent(requestId: number): boolean;
  finish(requestId: number): boolean;
  invalidate(requestId?: number): void;
}

/**
 * Coordinates browser-picker requests that must never overlap. The numeric
 * lease also lets callers ignore a response that arrives after its operation
 * was invalidated during a React StrictMode replay or component unmount.
 */
export function createExclusiveRequestGate(): ExclusiveRequestGate {
  let sequence = 0;
  let activeRequestId: number | null = null;

  return {
    tryStart() {
      if (activeRequestId !== null) return null;
      activeRequestId = ++sequence;
      return activeRequestId;
    },

    isBusy() {
      return activeRequestId !== null;
    },

    isCurrent(requestId) {
      return activeRequestId === requestId;
    },

    finish(requestId) {
      if (activeRequestId !== requestId) return false;
      activeRequestId = null;
      return true;
    },

    invalidate(requestId) {
      if (requestId !== undefined && activeRequestId !== requestId) return;
      activeRequestId = null;
      sequence += 1;
    },
  };
}
