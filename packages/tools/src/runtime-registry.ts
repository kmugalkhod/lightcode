import {
  codingToolInputSchemas,
  codingToolOutputSchemas,
  type CodingToolName,
  type CodingToolOutputByName,
} from "./agent-tools";
import { executeBash } from "./bash/runtime";
import { executeEditFile } from "./edit-file/runtime";
import { executeGrep } from "./grep/runtime";
import { executeListFiles } from "./list-files/runtime";
import { executeReadFile } from "./read-file/runtime";
import { executeWriteFile } from "./write-file/runtime";

async function executeToolByName(toolName: CodingToolName, input: unknown): Promise<CodingToolOutputByName[CodingToolName]> {
  switch (toolName) {
    case "list_files":
      return executeListFiles(input);
    case "read_file":
      return executeReadFile(input);
    case "grep":
      return executeGrep(input);
    case "write_file":
      return executeWriteFile(input);
    case "edit_file":
      return executeEditFile(input);
    case "bash":
      return executeBash(input);
  }
}

export async function executeCodingTool(toolName: CodingToolName, rawInput: unknown): Promise<unknown> {
  const validatedInput = codingToolInputSchemas[toolName].parse(rawInput);
  const rawOutput = await executeToolByName(toolName, validatedInput);
  return codingToolOutputSchemas[toolName].parse(rawOutput);
}
