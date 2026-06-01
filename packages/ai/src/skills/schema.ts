import { z } from "zod";

export const skillDescription =
  "Load a local Lightcode skill by name and return its instructions and metadata.";

export const skillInputSchema = z.object({
  name: z.string().min(1).max(160),
});

export const skillProviderInputSchema = skillInputSchema;

export const skillSummarySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  path: z.string().min(1),
  source: z.enum(["project", "user"]),
});

export const skillOutputSchema = z.object({
  skill: skillSummarySchema,
  content: z.string(),
});

export const skillListOutputSchema = z.object({
  skills: z.array(skillSummarySchema),
});

export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SkillInput = z.infer<typeof skillInputSchema>;
export type SkillOutput = z.infer<typeof skillOutputSchema>;
