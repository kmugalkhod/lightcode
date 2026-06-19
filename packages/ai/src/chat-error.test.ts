import { describe, expect, test } from "bun:test";
import { retryReasonLabel } from "./chat-error";

describe("retryReasonLabel", () => {
  test("names the true cause for classified retry reasons", () => {
    expect(retryReasonLabel("provider_unavailable")).toBe("Provider unavailable");
    expect(retryReasonLabel("rate_limit")).toBe("Rate limited");
    expect(retryReasonLabel("context_overflow")).toBe("Context window exceeded");
  });

  test("uses 'Stalled' for a silent-stream stall", () => {
    expect(retryReasonLabel("stall")).toBe("Stalled");
  });

  test("keeps 'Connection dropped' for true network drops and unknown cause", () => {
    expect(retryReasonLabel("network")).toBe("Connection dropped");
    expect(retryReasonLabel(undefined)).toBe("Connection dropped");
  });
});
