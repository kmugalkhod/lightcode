import { z } from "zod";

const integerNumberSchema = z
  .number()
  .finite()
  .refine((value) => Number.isInteger(value), { error: "Expected an integer value." });

export function integerRangeSchema(min: number, max: number, label: string) {
  return integerNumberSchema.refine((value) => value >= min && value <= max, {
    error: `${label} must be between ${min} and ${max}.`,
  });
}

export const boundedPathSchema = z.string().min(1).max(4096);

export const positiveLineSchema = integerRangeSchema(1, 1_000_000, "Line number");
