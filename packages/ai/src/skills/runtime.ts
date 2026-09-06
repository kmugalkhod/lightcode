import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  skillInputSchema,
  skillOutputSchema,
  type SkillSummary,
} from "./schema";

interface SkillDiscoveryRoot {
  source: SkillSummary["source"];
  path: string;
}

interface SkillDiscoveryOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

function defaultSkillRoots(
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): SkillDiscoveryRoot[] {
  return [
    { source: "project", path: path.join(cwd, ".lightcode", "skills") },
    { source: "project", path: path.join(cwd, ".agents", "skills") },
    ...[".claude", ".codex", ".opencode"].map((dir) => ({
      source: "project" as const,
      path: path.join(cwd, dir, "skills"),
    })),
    ...[".lightcode", ".agents", ".claude"].map((dir) => ({
      source: "user" as const,
      path: path.join(home, dir, "skills"),
    })),
    {
      source: "user",
      path: path.join(env.CODEX_HOME || path.join(home, ".codex"), "skills"),
    },
    {
      source: "user",
      path: path.join(
        env.XDG_CONFIG_HOME || path.join(home, ".config"),
        "opencode",
        "skills",
      ),
    },
    ...(env.LIGHTCODE_SKILL_PATHS ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((root) => ({
        source: "user" as const,
        path: path.resolve(cwd, root),
      })),
  ];
}

function normalizeSkillName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
}

function parseBasicFrontmatter(content: string): Record<string, string> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  const parsed: unknown = Bun.YAML.parse(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function findSkillFiles(root: SkillDiscoveryRoot): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = (directory: string, depth: number) => {
    if (depth > 8 || visited.size >= 2_000) {
      return;
    }
    let entries: string[];
    try {
      const real = realpathSync(directory);
      if (visited.has(real)) return;
      visited.add(real);
      entries = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      try {
        const stat = statSync(entryPath);
        if (stat.isDirectory()) {
          visit(entryPath, depth + 1);
        } else if (
          stat.isFile() &&
          stat.size <= 1_048_576 &&
          entry.toLowerCase() === "skill.md"
        ) {
          files.push(entryPath);
        }
      } catch {
        // Ignore inaccessible files and broken installation symlinks.
      }
    }
  };

  visit(root.path, 0);
  return files;
}

// Skills are listed on every chat request (workspace context + fast-path
// routing) and rarely change mid-session; a short TTL turns the recursive
// directory walk + frontmatter reads into a lookup. New skills appear within
// the TTL; `clearSkillsCache` exists for tests and explicit refreshes.
const skillsCacheTtlMs = 30_000;
const skillsCache = new Map<
  string,
  { expiresAt: number; skills: SkillSummary[] }
>();

export function clearSkillsCache(): void {
  skillsCache.clear();
}

export function listSkills({
  cwd = process.cwd(),
  home = os.homedir(),
  env = process.env,
}: SkillDiscoveryOptions = {}): SkillSummary[] {
  const roots = defaultSkillRoots(path.resolve(cwd), home, env);
  const cacheKey = JSON.stringify(roots);
  const cached = skillsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.skills;
  }

  const skills = listSkillsUncached(roots);
  if (skillsCache.size >= 100)
    skillsCache.delete(skillsCache.keys().next().value!);
  skillsCache.set(cacheKey, {
    expiresAt: Date.now() + skillsCacheTtlMs,
    skills,
  });
  return skills;
}

function listSkillsUncached(roots: SkillDiscoveryRoot[]): SkillSummary[] {
  const seen = new Set<string>();
  const summaries: SkillSummary[] = [];

  for (const root of roots) {
    for (const skillPath of findSkillFiles(root)) {
      try {
        const content = readFileSync(skillPath, "utf8");
        const frontmatter = parseBasicFrontmatter(content);
        const fallbackName = path.basename(path.dirname(skillPath));
        const name = normalizeSkillName(frontmatter.name ?? fallbackName);
        if (!name || name.length > 160 || seen.has(name)) {
          continue;
        }

        seen.add(name);
        summaries.push({
          name,
          description: frontmatter.description || null,
          path: skillPath,
          source: root.source,
        });
      } catch {
        // One malformed or removed skill must not hide other skills.
      }
    }
  }

  return summaries.sort((left, right) => left.name.localeCompare(right.name));
}

export function loadSkill(input: unknown, options: SkillDiscoveryOptions = {}) {
  const parsedInput = skillInputSchema.parse(input);
  const normalizedName = normalizeSkillName(parsedInput.name);
  const skill = listSkills(options).find(
    (candidate) => normalizeSkillName(candidate.name) === normalizedName,
  );

  if (!skill) {
    throw new Error(`Skill not found: ${parsedInput.name}`);
  }

  const root = realpathSync(path.dirname(skill.path));
  const target = parsedInput.resource
    ? realpathSync(path.resolve(root, parsedInput.resource))
    : skill.path;
  if (parsedInput.resource) {
    const relative = path.relative(root, target);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        "Skill resources must stay inside the installed skill directory.",
      );
    }
  }
  const stat = statSync(target);
  if (!stat.isFile() || stat.size > 1_048_576)
    throw new Error("Skill resource must be a file smaller than 1 MiB.");

  return skillOutputSchema.parse({
    skill,
    content: readFileSync(target, "utf8"),
  });
}
