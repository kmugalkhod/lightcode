import { z } from "zod";

export const permissionModeOrder = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

export type PermissionMode = (typeof permissionModeOrder)[number];
export type PermissionOutcome = "allow" | "ask" | "deny";
export type PermissionRule = string;

export const permissionModeSchema = z.enum(permissionModeOrder);
export const permissionOutcomeSchema = z.enum(["allow", "ask", "deny"]);

export const permissionRulesSchema = z.object({
  allow: z.array(z.string().min(1).max(2_000)).optional(),
  deny: z.array(z.string().min(1).max(2_000)).optional(),
  ask: z.array(z.string().min(1).max(2_000)).optional(),
  deniedTools: z.array(z.string().min(1).max(120)).optional(),
});

export type PermissionRules = z.infer<typeof permissionRulesSchema>;

export interface PermissionRequest {
  toolName: string;
  input: unknown;
  activeMode: PermissionMode;
  requiredMode: PermissionMode;
}

export interface PermissionDecision {
  outcome: PermissionOutcome;
  toolName: string;
  activeMode: PermissionMode;
  requiredMode: PermissionMode;
  reason?: string;
}

export const permissionDecisionSchema = z.object({
  outcome: permissionOutcomeSchema,
  toolName: z.string().min(1).max(120),
  activeMode: permissionModeSchema,
  requiredMode: permissionModeSchema,
  reason: z.string().min(1).max(2_000).optional(),
});

export interface PermissionPolicyOptions {
  activeMode: PermissionMode;
  toolRequirements: Readonly<Record<string, PermissionMode>>;
  allowedTools?: readonly string[];
  rules?: PermissionRules;
  approved?: boolean;
}

const modeRank = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
} satisfies Record<PermissionMode, number>;

function normalizeToolName(value: string): string {
  return value.trim().replaceAll("-", "_").toLowerCase();
}

export function permissionModeMeets(
  activeMode: PermissionMode,
  requiredMode: PermissionMode,
) {
  return modeRank[activeMode] >= modeRank[requiredMode];
}

function toRuleLists(rules: PermissionRules | undefined) {
  return {
    allow: rules?.allow ?? [],
    deny: rules?.deny ?? [],
    ask: rules?.ask ?? [],
    deniedTools: rules?.deniedTools ?? [],
  };
}

type PermissionRuleMatcher =
  | { kind: "any" }
  | { kind: "exact"; value: string }
  | { kind: "prefix"; value: string };

interface ParsedPermissionRule {
  raw: string;
  toolName: string;
  matcher: PermissionRuleMatcher;
}

function findFirstUnescaped(value: string, needle: string): number {
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      escaped = !escaped;
      continue;
    }

    if (character === needle && !escaped) {
      return index;
    }

    escaped = false;
  }

  return -1;
}

function findLastUnescaped(value: string, needle: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] !== needle) {
      continue;
    }

    let backslashes = 0;
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      if (value[previousIndex] !== "\\") {
        break;
      }
      backslashes += 1;
    }

    if (backslashes % 2 === 0) {
      return index;
    }
  }

  return -1;
}

function unescapeRuleContent(content: string) {
  return content
    .replaceAll("\\(", "(")
    .replaceAll("\\)", ")")
    .replaceAll("\\\\", "\\");
}

function parseRuleMatcher(content: string): PermissionRuleMatcher {
  const unescaped = unescapeRuleContent(content.trim());

  if (!unescaped || unescaped === "*") {
    return { kind: "any" };
  }

  if (unescaped.endsWith(":*")) {
    return { kind: "prefix", value: unescaped.slice(0, -2) };
  }

  return { kind: "exact", value: unescaped };
}

function parsePermissionRule(rawRule: string): ParsedPermissionRule {
  const raw = rawRule.trim();
  const openIndex = findFirstUnescaped(raw, "(");
  const closeIndex = findLastUnescaped(raw, ")");

  if (openIndex > 0 && closeIndex === raw.length - 1 && openIndex < closeIndex) {
    const toolName = raw.slice(0, openIndex).trim();
    const matcherContent = raw.slice(openIndex + 1, closeIndex);

    if (toolName) {
      return {
        raw,
        toolName: normalizeToolName(toolName),
        matcher: parseRuleMatcher(matcherContent),
      };
    }
  }

  return {
    raw,
    toolName: normalizeToolName(raw),
    matcher: { kind: "any" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractPermissionSubject(input: unknown): string {
  if (isRecord(input)) {
    for (const key of [
      "command",
      "path",
      "query",
      "pattern",
      "filePath",
      "file_path",
      "url",
    ]) {
      const value = Reflect.get(input, key);
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  if (typeof input === "string" && input.trim()) {
    return input.trim();
  }

  return "";
}

function ruleMatches(rule: ParsedPermissionRule, toolName: string, input: unknown) {
  if (rule.toolName !== normalizeToolName(toolName)) {
    return false;
  }

  if (rule.matcher.kind === "any") {
    return true;
  }

  const subject = extractPermissionSubject(input);
  if (rule.matcher.kind === "exact") {
    return subject === rule.matcher.value;
  }

  return subject.startsWith(rule.matcher.value);
}

function findMatchingRule(
  rules: readonly string[],
  toolName: string,
  input: unknown,
) {
  return rules
    .map(parsePermissionRule)
    .find((rule) => ruleMatches(rule, toolName, input));
}

export class PermissionPolicy {
  private readonly activeMode: PermissionMode;
  private readonly toolRequirements: Readonly<Record<string, PermissionMode>>;
  private readonly allowedTools: ReadonlySet<string> | null;
  private readonly rules: ReturnType<typeof toRuleLists>;
  private readonly approved: boolean;

  constructor({
    activeMode,
    toolRequirements,
    allowedTools,
    rules,
    approved = false,
  }: PermissionPolicyOptions) {
    this.activeMode = activeMode;
    this.toolRequirements = toolRequirements;
    this.allowedTools =
      allowedTools && allowedTools.length > 0
        ? new Set(allowedTools.map(normalizeToolName))
        : null;
    this.rules = toRuleLists(rules);
    this.approved = approved;
  }

  requiredModeFor(toolName: string): PermissionMode {
    return this.toolRequirements[normalizeToolName(toolName)] ?? "danger-full-access";
  }

  decide(toolName: string, input: unknown): PermissionDecision {
    const normalizedToolName = normalizeToolName(toolName);
    const requiredMode = this.requiredModeFor(toolName);
    const baseDecision = {
      toolName,
      activeMode: this.activeMode,
      requiredMode,
    };

    if (this.allowedTools && !this.allowedTools.has(normalizedToolName)) {
      return {
        ...baseDecision,
        outcome: "deny",
        reason: `Tool "${toolName}" is not enabled for this session.`,
      };
    }

    if (
      this.rules.deniedTools
        .map(normalizeToolName)
        .includes(normalizedToolName)
    ) {
      return {
        ...baseDecision,
        outcome: "deny",
        reason: `Tool "${toolName}" is denied by policy.`,
      };
    }

    const denyRule = findMatchingRule(this.rules.deny, toolName, input);
    if (denyRule) {
      return {
        ...baseDecision,
        outcome: "deny",
        reason: `Tool "${toolName}" is denied by rule "${denyRule.raw}".`,
      };
    }

    const askRule = findMatchingRule(this.rules.ask, toolName, input);
    if (askRule && !this.approved) {
      return {
        ...baseDecision,
        outcome: "ask",
        reason: `Tool "${toolName}" requires approval by rule "${askRule.raw}".`,
      };
    }

    const allowRule = findMatchingRule(this.rules.allow, toolName, input);
    if (allowRule || permissionModeMeets(this.activeMode, requiredMode)) {
      return {
        ...baseDecision,
        outcome: "allow",
      };
    }

    if (
      this.activeMode === "workspace-write" &&
      requiredMode === "danger-full-access"
    ) {
      if (this.approved) {
        return {
          ...baseDecision,
          outcome: "allow",
        };
      }

      return {
        ...baseDecision,
        outcome: "ask",
        reason:
          `Tool "${toolName}" requires approval to escalate from ` +
          `${this.activeMode} to ${requiredMode}.`,
      };
    }

    // Live search is read-only with respect to the workspace but crosses the
    // network boundary. Plan mode may offer it, while still requiring an
    // explicit approval before the query/provider tool is exposed.
    if (
      normalizedToolName === "web_search" &&
      this.activeMode === "read-only" &&
      requiredMode === "danger-full-access"
    ) {
      if (this.approved) {
        return { ...baseDecision, outcome: "allow" };
      }
      return {
        ...baseDecision,
        outcome: "ask",
        reason: 'Tool "web_search" requires approval for network access.',
      };
    }

    return {
      ...baseDecision,
      outcome: "deny",
      reason:
        `Tool "${toolName}" requires ${requiredMode} permission; ` +
        `current mode is ${this.activeMode}.`,
    };
  }
}

export function formatPermissionDecision(decision: PermissionDecision) {
  return decision.reason ?? `Tool "${decision.toolName}" was ${decision.outcome}.`;
}

export class PermissionDeniedError extends Error {
  readonly decision: PermissionDecision;

  constructor(decision: PermissionDecision) {
    super(formatPermissionDecision(decision));
    this.name = "PermissionDeniedError";
    this.decision = decision;
  }
}

export function isPermissionDeniedError(
  error: unknown,
): error is PermissionDeniedError {
  return error instanceof PermissionDeniedError;
}
