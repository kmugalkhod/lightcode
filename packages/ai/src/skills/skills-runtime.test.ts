import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listSkills as discoverSkills,
  loadSkill as readSkill,
  clearSkillsCache,
} from "./runtime";

const listSkills = ({ cwd }: { cwd: string }) =>
  discoverSkills({ cwd, home: path.join(cwd, "home"), env: {} });
const loadSkill = (input: unknown, { cwd }: { cwd: string }) =>
  readSkill(input, { cwd, home: path.join(cwd, "home"), env: {} });

const tempRoots: string[] = [];

function createTempWorkspace() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "lightcode-skills-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  clearSkillsCache();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("skills resolver", () => {
  test("discovers shared agent installations, preserves precedence, and reads YAML descriptions", () => {
    const cwd = createTempWorkspace();
    for (const dir of [
      ".lightcode/skills/demo",
      "home/.agents/skills/demo",
      "home/.claude/skills/claude",
      "home/.codex/skills/.system/codex",
      "home/.config/opencode/skills/opencode",
    ]) {
      mkdirSync(path.join(cwd, dir), { recursive: true });
      writeFileSync(
        path.join(cwd, dir, "SKILL.md"),
        `---\nname: ${path.basename(dir)}\ndescription: >-\n  First line\n  second line\n---\nInstructions`,
      );
    }
    const skills = listSkills({ cwd });
    expect(skills.map((s) => s.name)).toEqual([
      "claude",
      "codex",
      "demo",
      "opencode",
    ]);
    expect(skills.find((s) => s.name === "demo")?.source).toBe("project");
    expect(skills[0]?.description).toBe("First line second line");
  });

  test("ignores broken links, loops and malformed skills without losing valid symlinked skills", () => {
    const cwd = createTempWorkspace();
    const root = path.join(cwd, ".agents/skills");
    const installed = path.join(cwd, "installed/demo");
    mkdirSync(root, { recursive: true });
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      path.join(installed, "SKILL.md"),
      "---\nname: linked\n---\nBody",
    );
    symlinkSync(installed, path.join(root, "linked"));
    symlinkSync(root, path.join(root, "loop"));
    symlinkSync(path.join(cwd, "missing"), path.join(root, "broken"));
    mkdirSync(path.join(root, "bad"));
    writeFileSync(
      path.join(root, "bad/SKILL.md"),
      "---\nname: [broken\n---\nBody",
    );
    expect(listSkills({ cwd }).map((s) => s.name)).toEqual(["linked"]);
  });

  test("supports custom roots and includes their configuration in the cache key", () => {
    const cwd = createTempWorkspace();
    const root = path.join(cwd, "external");
    mkdirSync(root);
    writeFileSync(path.join(root, "SKILL.md"), "---\nname: custom\n---\nBody");
    expect(listSkills({ cwd })).toEqual([]);
    expect(
      discoverSkills({
        cwd,
        home: path.join(cwd, "home"),
        env: { LIGHTCODE_SKILL_PATHS: root },
      }).map((s) => s.name),
    ).toEqual(["custom"]);
  });

  test("loads supporting resources while rejecting traversal and escaping symlinks", () => {
    const cwd = createTempWorkspace();
    const root = path.join(cwd, ".lightcode/skills/demo");
    mkdirSync(path.join(root, "references"), { recursive: true });
    writeFileSync(path.join(root, "SKILL.md"), "---\nname: demo\n---\nBody");
    writeFileSync(
      path.join(root, "references/guide.md"),
      "Supporting instructions",
    );
    const outside = path.join(cwd, "private.txt");
    writeFileSync(outside, "Private");
    symlinkSync(outside, path.join(root, "escape"));
    expect(
      loadSkill({ name: "demo", resource: "references/guide.md" }, { cwd })
        .content,
    ).toBe("Supporting instructions");
    expect(() =>
      loadSkill({ name: "demo", resource: "../../../private.txt" }, { cwd }),
    ).toThrow(/inside/);
    expect(() =>
      loadSkill({ name: "demo", resource: "escape" }, { cwd }),
    ).toThrow(/inside/);
  });
  test("lists and loads project-local skills from SKILL.md frontmatter", () => {
    const cwd = createTempWorkspace();
    const skillDir = path.join(cwd, ".lightcode", "skills", "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Demo Skill",
        "description: Helps with demos",
        "---",
        "",
        "Use this skill carefully.",
      ].join("\n"),
    );

    const skills = listSkills({ cwd });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "demo-skill",
      description: "Helps with demos",
      source: "project",
    });

    const loaded = loadSkill({ name: "demo skill" }, { cwd });
    expect(loaded.skill.name).toBe("demo-skill");
    expect(loaded.content).toContain("Use this skill carefully.");
  });

  test("dedupes skills that share a name (first discovery root wins)", () => {
    const cwd = createTempWorkspace();
    for (const dirName of ["a", "b"]) {
      const skillDir = path.join(cwd, ".lightcode", "skills", dirName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        path.join(skillDir, "SKILL.md"),
        ["---", "name: dupe", "description: variant", "---", ""].join("\n"),
      );
    }

    const skills = listSkills({ cwd });
    expect(skills.filter((skill) => skill.name === "dupe")).toHaveLength(1);
  });

  test("treats missing description as null", () => {
    const cwd = createTempWorkspace();
    const skillDir = path.join(cwd, ".lightcode", "skills", "bare");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: bare-skill", "---", "Body only."].join("\n"),
    );

    const [skill] = listSkills({ cwd });
    expect(skill.name).toBe("bare-skill");
    expect(skill.description).toBeNull();
  });

  test("throws when loading an unknown skill", () => {
    const cwd = createTempWorkspace();
    expect(() => loadSkill({ name: "does-not-exist" }, { cwd })).toThrow(
      /Skill not found/,
    );
  });
});
