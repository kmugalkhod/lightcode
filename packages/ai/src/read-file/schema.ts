import { z } from "zod";
import { MAX_TOOL_TEXT_OUTPUT_CHARS } from "../constants";
import { boundedPathSchema, integerRangeSchema, positiveLineSchema } from "../common/base-schemas";

export const readFileDescription =
  "Read file content from the working directory with optional line range limits.";

export const readFileInputSchema = z
  .object({
    path: boundedPathSchema,
    startLine: positiveLineSchema.optional(),
    endLine: positiveLineSchema.optional(),
    maxChars: integerRangeSchema(1, MAX_TOOL_TEXT_OUTPUT_CHARS, "maxChars").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.startLine !== undefined && value.endLine !== undefined && value.endLine < value.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endLine must be greater than or equal to startLine.",
        path: ["endLine"],
      });
    }
  });

export const readFileProviderInputSchema = readFileInputSchema;

export const readFileOutputSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  content: z.string(),
  totalLines: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
