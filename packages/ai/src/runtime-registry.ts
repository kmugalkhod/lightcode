import {
  codingToolInputSchemas,
  codingToolOutputSchemas,
  type CodingToolInputByName,
  type CodingToolName,
  type CodingToolOutputByName,
} from "./agent-tools";
import { executeBash } from "./bash/runtime";
import { executeEditFile } from "./edit-file/runtime";
import { executeGrep } from "./grep/runtime";
import { executeListFiles } from "./list-files/runtime";
import { executeReadFile } from "./read-file/runtime";
import { executeWriteFile } from "./write-file/runtime";

export function parseCodingToolInput(
  toolName: "list_files",
  rawInput: unknown,
): CodingToolInputByName["list_files"];
export function parseCodingToolInput(
  toolName: "read_file",
  rawInput: unknown,
): CodingToolInputByName["read_file"];
export function parseCodingToolInput(
  toolName: "grep",
  rawInput: unknown,
): CodingToolInputByName["grep"];
export function parseCodingToolInput(
  toolName: "write_file",
  rawInput: unknown,
): CodingToolInputByName["write_file"];
export function parseCodingToolInput(
  toolName: "edit_file",
  rawInput: unknown,
): CodingToolInputByName["edit_file"];
export function parseCodingToolInput(
  toolName: "bash",
  rawInput: unknown,
): CodingToolInputByName["bash"];
export function parseCodingToolInput(
  toolName: CodingToolName,
  rawInput: unknown,
): CodingToolInputByName[CodingToolName];
export function parseCodingToolInput(
  toolName: CodingToolName,
  rawInput: unknown,
): CodingToolInputByName[CodingToolName] {
  switch (toolName) {
    case "list_files":
      return codingToolInputSchemas.list_files.parse(rawInput);
    case "read_file":
      return codingToolInputSchemas.read_file.parse(rawInput);
    case "grep":
      return codingToolInputSchemas.grep.parse(rawInput);
    case "write_file":
      return codingToolInputSchemas.write_file.parse(rawInput);
    case "edit_file":
      return codingToolInputSchemas.edit_file.parse(rawInput);
    case "bash":
      return codingToolInputSchemas.bash.parse(rawInput);
  }
}

export function executeCodingTool(
  toolName: "list_files",
  input: CodingToolInputByName["list_files"],
): Promise<CodingToolOutputByName["list_files"]>;
export function executeCodingTool(
  toolName: "read_file",
  input: CodingToolInputByName["read_file"],
): Promise<CodingToolOutputByName["read_file"]>;
export function executeCodingTool(
  toolName: "grep",
  input: CodingToolInputByName["grep"],
): Promise<CodingToolOutputByName["grep"]>;
export function executeCodingTool(
  toolName: "write_file",
  input: CodingToolInputByName["write_file"],
): Promise<CodingToolOutputByName["write_file"]>;
export function executeCodingTool(
  toolName: "edit_file",
  input: CodingToolInputByName["edit_file"],
): Promise<CodingToolOutputByName["edit_file"]>;
export function executeCodingTool(
  toolName: "bash",
  input: CodingToolInputByName["bash"],
): Promise<CodingToolOutputByName["bash"]>;
export function executeCodingTool(
  toolName: CodingToolName,
  input: CodingToolInputByName[CodingToolName],
): Promise<CodingToolOutputByName[CodingToolName]>;
export async function executeCodingTool(
  toolName: CodingToolName,
  input: CodingToolInputByName[CodingToolName],
): Promise<CodingToolOutputByName[CodingToolName]> {
  switch (toolName) {
    case "list_files": {
      const validatedInput = codingToolInputSchemas.list_files.parse(input);
      const rawOutput = await executeListFiles(validatedInput);
      return codingToolOutputSchemas.list_files.parse(rawOutput);
    }
    case "read_file": {
      const validatedInput = codingToolInputSchemas.read_file.parse(input);
      const rawOutput = await executeReadFile(validatedInput);
      return codingToolOutputSchemas.read_file.parse(rawOutput);
    }
    case "grep": {
      const validatedInput = codingToolInputSchemas.grep.parse(input);
      const rawOutput = await executeGrep(validatedInput);
      return codingToolOutputSchemas.grep.parse(rawOutput);
    }
    case "write_file": {
      const validatedInput = codingToolInputSchemas.write_file.parse(input);
      const rawOutput = await executeWriteFile(validatedInput);
      return codingToolOutputSchemas.write_file.parse(rawOutput);
    }
    case "edit_file": {
      const validatedInput = codingToolInputSchemas.edit_file.parse(input);
      const rawOutput = await executeEditFile(validatedInput);
      return codingToolOutputSchemas.edit_file.parse(rawOutput);
    }
    case "bash": {
      const validatedInput = codingToolInputSchemas.bash.parse(input);
      const rawOutput = await executeBash(validatedInput);
      return codingToolOutputSchemas.bash.parse(rawOutput);
    }
  }
}
