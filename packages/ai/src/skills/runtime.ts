import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

function defaultSkillRoots(cwd: string): SkillDiscoveryRoot[] {
  return [
    { source: "project", path: path.join(cwd, ".lightcode", "skills") },
    { source: "project", path: path.join(cwd, ".agents", "skills") },
    { source: "user", path: path.join(os.homedir(), ".lightcode", "skills") },
  ];
}

function normalizeSkillName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function parseBasicFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) {
    return {};
  }

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return {};
  }

  const frontmatter = content.slice(3, endIndex).trim();
  return Object.fromEntries(
    frontmatter
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [
        match[1],
        match[2].replace(/^["']|["']$/g, "").trim(),
      ]),
  );
}

function findSkillFiles(root: SkillDiscoveryRoot): string[] {
  if (!existsSync(root.path)) {
    return [];
  }

  const files: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 4) {
      return;
    }

    for (const entry of readdirSync(directory)) {
      const entryPath = path.join(directory, entry);
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        visit(entryPath, depth + 1);
      } else if (entry.toLowerCase() === "skill.md") {
        files.push(entryPath);
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
}: {
  cwd?: string;
} = {}): SkillSummary[] {
  const cached = skillsCache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.skills;
  }

  const skills = listSkillsUncached(cwd);
  skillsCache.set(cwd, {
    expiresAt: Date.now() + skillsCacheTtlMs,
    skills,
  });
  return skills;
}

function listSkillsUncached(cwd: string): SkillSummary[] {
  const seen = new Set<string>();
  const summaries: SkillSummary[] = [];

  for (const root of defaultSkillRoots(cwd)) {
    for (const skillPath of findSkillFiles(root)) {
      const content = readFileSync(skillPath, "utf8");
      const frontmatter = parseBasicFrontmatter(content);
      const fallbackName = path.basename(path.dirname(skillPath));
      const name = normalizeSkillName(frontmatter.name ?? fallbackName);
      if (!name || seen.has(name)) {
        continue;
      }

      seen.add(name);
      summaries.push({
        name,
        description: frontmatter.description || null,
        path: skillPath,
        source: root.source,
      });
    }
  }

  return summaries.sort((left, right) => left.name.localeCompare(right.name));
}

export function loadSkill(
  input: unknown,
  { cwd = process.cwd() }: { cwd?: string } = {},
) {
  const parsedInput = skillInputSchema.parse(input);
  const normalizedName = normalizeSkillName(parsedInput.name);
  const skill = listSkills({ cwd }).find(
    (candidate) => normalizeSkillName(candidate.name) === normalizedName,
  );

  if (!skill) {
    throw new Error(`Skill not found: ${parsedInput.name}`);
  }

  return skillOutputSchema.parse({
    skill,
    content: readFileSync(skill.path, "utf8"),
  });
}
