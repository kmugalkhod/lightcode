import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { coerceToolInputToSchema } from "./coerce-tool-input";

const schema = z.object({
  path: z.string(),
  offset: z.number().int().optional(),
  recursive: z.boolean().optional(),
});

describe("coerceToolInputToSchema", () => {
  test("coerces a numeric string to a number", () => {
    expect(
      coerceToolInputToSchema({ path: "a.ts", offset: "10" }, schema),
    ).toEqual({ path: "a.ts", offset: 10 });
  });

  test("coerces a string to a boolean", () => {
    expect(
      coerceToolInputToSchema({ path: "src", recursive: "true" }, schema),
    ).toEqual({ path: "src", recursive: true });
    expect(
      coerceToolInputToSchema({ path: "src", recursive: "false" }, schema),
    ).toEqual({ path: "src", recursive: false });
  });

  test("coerces several wrong-typed fields at once", () => {
    expect(
      coerceToolInputToSchema(
        { path: "src", offset: "5", recursive: "1" },
        schema,
      ),
    ).toEqual({ path: "src", offset: 5, recursive: true });
  });

  test("returns the value unchanged when already valid", () => {
    expect(
      coerceToolInputToSchema({ path: "a.ts", offset: 3 }, schema),
    ).toEqual({ path: "a.ts", offset: 3 });
  });

  test("returns null when a required field is genuinely missing", () => {
    expect(coerceToolInputToSchema({ offset: "10" }, schema)).toBeNull();
  });

  test("returns null when a string is not a parseable number", () => {
    expect(
      coerceToolInputToSchema({ path: "a.ts", offset: "abc" }, schema),
    ).toBeNull();
  });

  test("does not mutate the caller's object", () => {
    const input = { path: "a.ts", offset: "10" };
    coerceToolInputToSchema(input, schema);
    expect(input.offset).toBe("10");
  });

  test("works through a superRefine wrapper", () => {
    const refined = z
      .object({ start: z.number(), end: z.number() })
      .superRefine((value, ctx) => {
        if (value.end < value.start) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "end<start" });
        }
      });
    expect(
      coerceToolInputToSchema({ start: "1", end: "2" }, refined),
    ).toEqual({ start: 1, end: 2 });
  });
});
