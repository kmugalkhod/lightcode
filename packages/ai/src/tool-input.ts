import type { CodingToolInputByName, CodingToolName } from "./agent-tools";
import { coerceToolInputToSchema } from "./common/coerce-tool-input";
import { codingToolInputSchemas } from "./tool-registry";

/**
 * Parses provider tool input without importing any execution runtime.
 *
 * Keeping this helper separate from runtime-registry lets browser clients
 * validate streamed tool calls without pulling filesystem, subprocess, or
 * networking implementations into their bundle.
 */
export function parseCodingToolInput<K extends CodingToolName>(
  toolName: K,
  rawInput: unknown,
): CodingToolInputByName[K] {
  // The schema map is keyed by tool name; indexing erases the per-key
  // relation, so narrow the parsed union back to the requested tool.
  const schema = codingToolInputSchemas[toolName];
  const parsed = schema.safeParse(rawInput);
  if (parsed.success) {
    return parsed.data as CodingToolInputByName[K];
  }

  // Cheaper models get the argument shape right but the types wrong (a number
  // sent as "10", a boolean as "true"). Coerce against the schema before giving
  // up so the call succeeds instead of failing strict validation.
  const coerced = coerceToolInputToSchema(rawInput, schema);
  if (coerced !== null) {
    return coerced as CodingToolInputByName[K];
  }

  // Still invalid (e.g. a required field is genuinely missing) — surface the
  // original, descriptive validation error.
  return schema.parse(rawInput) as CodingToolInputByName[K];
}
