import { z } from "zod";
import { READ_FILE_OUTPUT_CHARS } from "../constants";
import { boundedPathSchema, integerRangeSchema, positiveLineSchema } from "../common/base-schemas";

export const readFileDescription =
  "Read file content from the working directory. Returns whole lines, up to about 24,000 characters (roughly 600 lines) per call, so read a file in one call instead of in slices. " +
  "If the file is longer, the result stops at endLine and nextStartLine says where to continue. " +
  "To inspect one spot in a large file, grep for it first, then read a generous startLine/endLine range around it.";

export const readFileInputSchema = z
  .object({
    path: boundedPathSchema,
    startLine: positiveLineSchema.optional(),
    endLine: positiveLineSchema.optional(),
    maxChars: integerRangeSchema(1, READ_FILE_OUTPUT_CHARS, "maxChars").optional(),
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

export const readFileProviderInputSchema = z.object({
  path: boundedPathSchema,
  startLine: positiveLineSchema.optional(),
  endLine: positiveLineSchema.optional(),
});

export const readFileOutputSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  content: z.string(),
  totalLines: z.number().int().nonnegative(),
  truncated: z.boolean(),
  /** First line not returned because of the size budget; read on from here. */
  nextStartLine: z.number().int().min(1).optional(),
});
