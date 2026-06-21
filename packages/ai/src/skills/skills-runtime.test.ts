import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSkills, loadSkill } from "./runtime";

const tempRoots: string[] = [];

function createTempWorkspace() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "lightcode-skills-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("skills resolver", () => {
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
