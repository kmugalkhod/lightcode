import { z } from "zod";

export const attachmentContentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);

export const fileReferenceDataSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    range: z
      .object({
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
      })
      .refine((range) => range.endLine >= range.startLine)
      .optional(),
    contentHash: attachmentContentHashSchema,
  })
  .strict();
export type FileReferenceData = z.infer<typeof fileReferenceDataSchema>;

export const fileReferenceUIPartSchema = z
  .object({
    type: z.literal("data-file-ref"),
    data: fileReferenceDataSchema,
  })
  .strict();
export type FileReferenceUIPart = z.infer<typeof fileReferenceUIPartSchema>;

export const blobReferenceDataSchema = z
  .object({
    contentHash: attachmentContentHashSchema,
    mediaType: z.string().min(1).max(200),
    filename: z.string().min(1).max(1_024).optional(),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type BlobReferenceData = z.infer<typeof blobReferenceDataSchema>;

export const blobReferenceUIPartSchema = z
  .object({
    type: z.literal("data-blob-ref"),
    data: blobReferenceDataSchema,
  })
  .strict();
export type BlobReferenceUIPart = z.infer<typeof blobReferenceUIPartSchema>;
