import { describe, expect, test } from "bun:test";
import {
  containsProposedPlanBlock,
  countPlanContent,
  extractFirstHeading,
  splitProposedPlanBlocks,
} from "./chat-proposed-plan-card";

describe("proposed plan parsing", () => {
  test("detects and extracts an exact proposed plan block", () => {
    const text = "<proposed_plan>\n# Plan\n\n- Step one\n</proposed_plan>";
    const segments = splitProposedPlanBlocks(text);

    expect(segments).toEqual([
      {
        type: "plan",
        text: "# Plan\n\n- Step one",
      },
    ]);
    expect(containsProposedPlanBlock(text)).toBe(true);
    expect(containsProposedPlanBlock(segments[0].text)).toBe(false);
  });

  test("preserves surrounding normal text as separate segments", () => {
    const segments = splitProposedPlanBlocks(
      "Intro\n<proposed_plan>\n# Plan\n</proposed_plan>\nOutro",
    );

    expect(segments).toEqual([
      { type: "text", text: "Intro\n" },
      { type: "plan", text: "# Plan" },
      { type: "text", text: "\nOutro" },
    ]);
  });

  test("leaves malformed plan tags as normal text", () => {
    const text = "Intro\n<proposed_plan>\n# Plan";

    expect(splitProposedPlanBlocks(text)).toEqual([{ type: "text", text }]);
    expect(containsProposedPlanBlock(text)).toBe(false);
  });
});

describe("countPlanContent", () => {
  describe("section counting", () => {
    test("counts zero sections for plain text", () => {
      const result = countPlanContent("Some regular text\nwith no headings");
      expect(result.sections).toBe(0);
    });

    test("counts single section heading", () => {
      const result = countPlanContent("# Introduction");
      expect(result.sections).toBe(1);
    });

    test("counts multiple section headings at different levels", () => {
      const result = countPlanContent("# Overview\n## Details\n### Subpoints");
      expect(result.sections).toBe(3);
    });

    test("does not count lines with # inside text", () => {
      const result = countPlanContent("Text with # symbol inside\n# A real heading");
      expect(result.sections).toBe(1);
    });
  });

  describe("bullet counting", () => {
    test("counts zero bullets for plain text", () => {
      const result = countPlanContent("Just some text");
      expect(result.bullets).toBe(0);
    });

    test("counts unordered list items with dash", () => {
      const result = countPlanContent("- Item one\n- Item two");
      expect(result.bullets).toBe(2);
    });

    test("counts unordered list items with asterisk", () => {
      const result = countPlanContent("* First\n* Second\n* Third");
      expect(result.bullets).toBe(3);
    });

    test("counts unordered list items with plus", () => {
      const result = countPlanContent("+ Alpha\n+ Beta");
      expect(result.bullets).toBe(2);
    });

    test("counts ordered list items", () => {
      const result = countPlanContent("1. Step one\n2. Step two\n3. Step three");
      expect(result.bullets).toBe(3);
    });

    test("counts mixed unordered and ordered bullets", () => {
      const result = countPlanContent("- First\n1. Second\n* Third\n2. Fourth");
      expect(result.bullets).toBe(4);
    });
  });

  describe("combined scenarios", () => {
    test("counts sections and bullets together", () => {
      const result = countPlanContent(
        "# Overview\n\n- Setup\n- Configure\n\n## Implementation\n\n1. Create files\n2. Run tests\n\n- Cleanup",
      );
      expect(result.sections).toBe(2);
      expect(result.bullets).toBe(5);
    });

    test("handles empty text", () => {
      const result = countPlanContent("");
      expect(result.sections).toBe(0);
      expect(result.bullets).toBe(0);
    });

    test("handles whitespace-only text", () => {
      const result = countPlanContent("   \n\n   \n");
      expect(result.sections).toBe(0);
      expect(result.bullets).toBe(0);
    });

    test("handles content with only headings and bullets", () => {
      const result = countPlanContent("# Header\n- Bullet\n## Subheader\n1. Ordered");
      expect(result.sections).toBe(2);
      expect(result.bullets).toBe(2);
    });
  });
});

describe("extractFirstHeading", () => {
  test("extracts h1 heading", () => {
    expect(extractFirstHeading("# My Plan")).toBe("My Plan");
  });

  test("extracts h2 heading", () => {
    expect(extractFirstHeading("## Implementation")).toBe("Implementation");
  });

  test("extracts h3 heading", () => {
    expect(extractFirstHeading("### Details")).toBe("Details");
  });

  test("extracts h4-h6 headings", () => {
    expect(extractFirstHeading("#### Sub-sub")).toBe("Sub-sub");
    expect(extractFirstHeading("##### Deep")).toBe("Deep");
    expect(extractFirstHeading("###### Deepest")).toBe("Deepest");
  });

  test("returns undefined when no heading exists", () => {
    expect(extractFirstHeading("Just some text")).toBeUndefined();
    expect(extractFirstHeading("")).toBeUndefined();
    expect(extractFirstHeading("- item")).toBeUndefined();
  });

  test("trims heading text", () => {
    expect(extractFirstHeading("#   Title with spaces   ")).toBe("Title with spaces");
  });

  test("extracts first heading when multiple exist", () => {
    expect(extractFirstHeading("# First\n## Second")).toBe("First");
  });

  test("finds heading not at start of text", () => {
    expect(extractFirstHeading("Intro text\n# Found it")).toBe("Found it");
  });
});