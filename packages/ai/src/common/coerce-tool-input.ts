import type { ZodType } from "zod";

/**
 * Cheaper models reliably get the SHAPE of tool arguments right but the TYPES
 * wrong — they emit `"10"` for a number or `"true"` for a boolean. Strict
 * validation then rejects an otherwise-usable call. This coerces those near
 * misses against the tool's own schema so the call succeeds instead of failing.
 *
 * It is driven by the schema's validation issues (path + expected type) rather
 * than by introspecting Zod internals, so it is agnostic to the Zod version and
 * works through wrappers like `.superRefine`. It never fabricates missing data:
 * a required field the model simply omitted stays missing and the call fails.
 */

const NO_CHANGE = Symbol("no-change");
const MAX_PASSES = 4;

function coercePrimitive(
  current: unknown,
  expected: string,
): unknown | typeof NO_CHANGE {
  if (current === undefined || current === null) {
    return NO_CHANGE; // can't invent a value the model never sent
  }

  switch (expected) {
    case "number": {
      if (typeof current === "string") {
        const trimmed = current.trim();
        if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
          return Number(trimmed);
        }
      }
      return NO_CHANGE;
    }
    case "boolean": {
      if (typeof current === "string") {
        const lowered = current.trim().toLowerCase();
        if (lowered === "true" || lowered === "1" || lowered === "yes") {
          return true;
        }
        if (lowered === "false" || lowered === "0" || lowered === "no") {
          return false;
        }
      }
      if (current === 1) return true;
      if (current === 0) return false;
      return NO_CHANGE;
    }
    case "string": {
      if (typeof current === "number" || typeof current === "boolean") {
        return String(current);
      }
      return NO_CHANGE;
    }
    case "object":
    case "array": {
      if (typeof current === "string") {
        try {
          const parsed = JSON.parse(current);
          const isArray = Array.isArray(parsed);
          const matches =
            expected === "array"
              ? isArray
              : parsed !== null && typeof parsed === "object" && !isArray;
          if (matches) {
            return parsed;
          }
        } catch {
          // not JSON — leave as-is
        }
      }
      return NO_CHANGE;
    }
    default:
      return NO_CHANGE;
  }
}

function coerceAtPath(
  root: unknown,
  path: readonly PropertyKey[],
  expected: string,
): boolean {
  if (path.length === 0 || root === null || typeof root !== "object") {
    return false;
  }

  let parent = root as Record<PropertyKey, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    const next = parent[path[index]];
    if (next === null || typeof next !== "object") {
      return false;
    }
    parent = next as Record<PropertyKey, unknown>;
  }

  const key = path[path.length - 1];
  const coerced = coercePrimitive(parent[key], expected);
  if (coerced === NO_CHANGE) {
    return false;
  }
  parent[key] = coerced;
  return true;
}

/**
 * Returns the parsed, type-coerced value on success, or null when it cannot be
 * made valid (e.g. a required field is genuinely missing). Operates on a clone,
 * so the caller's value is never mutated.
 */
export function coerceToolInputToSchema(
  value: unknown,
  schema: ZodType,
): unknown | null {
  if (value === null || typeof value !== "object") {
    return null;
  }

  let current: unknown;
  try {
    current = structuredClone(value);
  } catch {
    current = value;
  }

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result = schema.safeParse(current);
    if (result.success) {
      return result.data;
    }

    let changed = false;
    for (const issue of result.error.issues) {
      if (issue.code !== "invalid_type") {
        continue;
      }
      const expected = (issue as { expected?: string }).expected;
      if (typeof expected !== "string") {
        continue;
      }
      if (coerceAtPath(current, issue.path, expected)) {
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  const final = schema.safeParse(current);
  return final.success ? final.data : null;
}
