import { describe, expect, test } from "bun:test";
import { resolveCodingSessionRequestOption } from "./request-options";

describe("resolveCodingSessionRequestOption", () => {
  test("returns a static option", async () => {
    await expect(
      resolveCodingSessionRequestOption({ Authorization: "Bearer static" }),
    ).resolves.toEqual({ Authorization: "Bearer static" });
  });

  test("resolves a fresh async option on every request", async () => {
    let token = "first";
    const headers = () =>
      Promise.resolve({ Authorization: `Bearer ${token}` });

    await expect(resolveCodingSessionRequestOption(headers)).resolves.toEqual({
      Authorization: "Bearer first",
    });
    token = "second";
    await expect(resolveCodingSessionRequestOption(headers)).resolves.toEqual({
      Authorization: "Bearer second",
    });
  });

  test("keeps an omitted option omitted", async () => {
    await expect(resolveCodingSessionRequestOption(undefined)).resolves.toBe(
      undefined,
    );
  });
});
