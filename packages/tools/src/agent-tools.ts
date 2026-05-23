import { z } from "zod";
import {
  ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
  MAX_TOOL_LIST_ENTRIES,
  MAX_TOOL_SEARCH_RESULTS,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
} from "./constants";
import {
  bashDescription,
  bashInputSchema,
  bashOutputSchema,
  bashProviderInputSchema,
} from "./bash/schema";
import {
  editFileDescription,
  editFileInputSchema,
  editFileOutputSchema,
  editFileProviderInputSchema,
} from "./edit-file/schema";
import {
  grepDescription,
  grepInputSchema,
  grepOutputSchema,
  grepProviderInputSchema,
} from "./grep/schema";
import {
  listFilesDescription,
  listFilesInputSchema,
  listFilesOutputSchema,
  listFilesProviderInputSchema,
} from "./list-files/schema";
import {
  readFileDescription,
  readFileInputSchema,
  readFileOutputSchema,
  readFileProviderInputSchema,
} from "./read-file/schema";
import {
  writeFileDescription,
  writeFileInputSchema,
  writeFileOutputSchema,
  writeFileProviderInputSchema,
} from "./write-file/schema";

export {
  ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET,
  MAX_TOOL_LIST_ENTRIES,
  MAX_TOOL_SEARCH_RESULTS,
  MAX_TOOL_TEXT_OUTPUT_CHARS,
};

export const codingChatRequestSchema = z.object({
  messages: z.unknown(),
  cwd: z.string().min(1).max(4096),
});

export const codingToolDescriptions = {
  list_files: listFilesDescription,
  read_file: readFileDescription,
  grep: grepDescription,
  write_file: writeFileDescription,
  edit_file: editFileDescription,
  bash: bashDescription,
} as const;

export const codingToolInputSchemas = {
  list_files: listFilesInputSchema,
  read_file: readFileInputSchema,
  grep: grepInputSchema,
  write_file: writeFileInputSchema,
  edit_file: editFileInputSchema,
  bash: bashInputSchema,
} as const;

export const codingToolProviderInputSchemas = {
  list_files: listFilesProviderInputSchema,
  read_file: readFileProviderInputSchema,
  grep: grepProviderInputSchema,
  write_file: writeFileProviderInputSchema,
  edit_file: editFileProviderInputSchema,
  bash: bashProviderInputSchema,
} as const;

export const codingToolOutputSchemas = {
  list_files: listFilesOutputSchema,
  read_file: readFileOutputSchema,
  grep: grepOutputSchema,
  write_file: writeFileOutputSchema,
  edit_file: editFileOutputSchema,
  bash: bashOutputSchema,
} as const;

export type CodingToolName = keyof typeof codingToolInputSchemas;

export type CodingToolInputByName = {
  [K in CodingToolName]: z.infer<(typeof codingToolInputSchemas)[K]>;
};

export type CodingToolOutputByName = {
  [K in CodingToolName]: z.infer<(typeof codingToolOutputSchemas)[K]>;
};

export const riskyCodingTools = ["write_file", "edit_file", "bash"] as const;
export type RiskyCodingToolName = (typeof riskyCodingTools)[number];

export const codingAgentCallOptionsSchema = z.object({
  cwd: z.string().min(1).max(4096),
});

function topLevelOptionalPropertyCount(schema: z.ZodObject) {
  return Object.values(schema.shape).reduce((count, propertySchema) => {
    return propertySchema.isOptional() ? count + 1 : count;
  }, 0);
}

export function collectToolSchemaPreflight() {
  const entries = Object.entries(codingToolProviderInputSchemas).map(([toolName, schema]) => {
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(`Tool "${toolName}" provider-facing schema must be a top-level object.`);
    }

    const jsonSchema = z.toJSONSchema(schema, {
      target: "draft-7",
      io: "input",
    }) as {
      type?: unknown;
      properties?: Record<string, unknown>;
      required?: unknown;
    };

    const optionalPropertyCount = topLevelOptionalPropertyCount(schema);

    return {
      toolName,
      inputSchemaType: typeof jsonSchema.type === "string" ? jsonSchema.type : undefined,
      optionalPropertyCount,
    };
  });

  return entries;
}

export function assertProviderToolSchemaBudget(
  maxOptionalProperties = ANTHROPIC_TOOL_OPTIONAL_PARAMETER_BUDGET
) {
  const preflightEntries = collectToolSchemaPreflight();

  for (const entry of preflightEntries) {
    if (entry.inputSchemaType !== "object") {
      throw new Error(
        `Tool "${entry.toolName}" provider-facing input schema must compile to JSON schema type "object".`
      );
    }

    if (entry.optionalPropertyCount > maxOptionalProperties) {
      throw new Error(
        `Tool "${entry.toolName}" has ${entry.optionalPropertyCount} optional top-level properties (max ${maxOptionalProperties}).`
      );
    }
  }
}
