import { describe, expect, test } from "bun:test";
import { createExclusiveRequestGate } from "./exclusive-request-gate";

describe("exclusive request gate", () => {
  test("rejects overlapping work until the active request finishes", () => {
    const gate = createExclusiveRequestGate();
    const first = gate.tryStart();

    expect(first).not.toBeNull();
    expect(gate.isBusy()).toBe(true);
    expect(gate.tryStart()).toBeNull();
    expect(gate.finish(first!)).toBe(true);
    expect(gate.isBusy()).toBe(false);
    expect(gate.tryStart()).not.toBeNull();
  });

  test("ignores stale responses after an invalidation", () => {
    const gate = createExclusiveRequestGate();
    const stale = gate.tryStart();

    expect(stale).not.toBeNull();
    gate.invalidate(stale!);

    const current = gate.tryStart();
    expect(current).not.toBeNull();
    expect(gate.isCurrent(stale!)).toBe(false);
    expect(gate.finish(stale!)).toBe(false);
    expect(gate.isCurrent(current!)).toBe(true);
  });

  test("does not invalidate a newer request with an old cleanup", () => {
    const gate = createExclusiveRequestGate();
    const first = gate.tryStart()!;
    gate.invalidate(first);
    const second = gate.tryStart()!;

    gate.invalidate(first);

    expect(gate.isCurrent(second)).toBe(true);
  });
});
