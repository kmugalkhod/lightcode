import { z } from "zod";
import {
  codingToolDescriptions,
  codingToolPermissionRequirements,
} from "../agent-tools";
import {
  codingAgentModes,
  type CodingAgentMode,
  type CodingAgentToolName,
} from "../coding-agent-modes";
import { toolSearchInputSchema, toolSearchOutputSchema } from "./schema";

type ToolSearchInput = z.input<typeof toolSearchInputSchema>;
type ToolSearchOutput = z.infer<typeof toolSearchOutputSchema>;

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function getActiveModes(toolName: CodingAgentToolName): CodingAgentMode[] {
  return Object.entries(codingAgentModes)
    .filter(([, definition]) => definition.activeTools.includes(toolName))
    .map(([mode]) => mode as CodingAgentMode);
}

function scoreTool(queryTokens: string[], toolName: CodingAgentToolName) {
  const description = codingToolDescriptions[toolName];
  const haystack = tokenize(`${toolName} ${description}`);
  const haystackText = haystack.join(" ");
  let score = 0;

  for (const token of queryTokens) {
    if (toolName.toLowerCase().includes(token)) {
      score += 5;
      continue;
    }

    if (haystack.includes(token)) {
      score += 3;
      continue;
    }

    if (haystackText.includes(token)) {
      score += 1;
    }
  }

  return score;
}

export async function executeToolSearch(
  input: ToolSearchInput,
): Promise<ToolSearchOutput> {
  const parsedInput = toolSearchInputSchema.parse(input);
  const queryTokens = tokenize(parsedInput.query);
  const scoredTools = (Object.keys(codingToolDescriptions) as CodingAgentToolName[])
    .map((toolName) => ({
      name: toolName,
      description: codingToolDescriptions[toolName],
      permissionMode: codingToolPermissionRequirements[toolName],
      activeModes: getActiveModes(toolName),
      score: scoreTool(queryTokens, toolName),
    }))
    .filter((tool) => tool.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.name.localeCompare(right.name);
    });
  const results = scoredTools.slice(0, parsedInput.maxResults);

  return toolSearchOutputSchema.parse({
    query: parsedInput.query,
    results,
    totalResults: scoredTools.length,
    truncated: scoredTools.length > results.length,
  });
}
