import { describe, it, expect } from "vitest";
import {
  parseReviewOutput,
  extractLastJsonBlock,
  validateReviewShape,
  REVIEW_JSON_INSTRUCTION,
} from "../src/review-output.js";

const GOOD_BLOCK =
  "Some prose analysis here about the diff.\n\n" +
  "Top finding: an off-by-one in the loop.\n\n" +
  "```json\n" +
  JSON.stringify(
    {
      verdict: "needs-attention",
      summary: "One critical bug found in the loop bound.",
      findings: [
        {
          severity: "critical",
          title: "Off-by-one",
          body: "The loop uses < instead of <=.",
          file: "src/loop.ts",
          line_start: 12,
          line_end: 12,
          confidence: 0.9,
          recommendation: "Change < to <=.",
        },
        {
          severity: "low",
          title: "Missing comment",
          body: "No docstring.",
          recommendation: "Add a docstring.",
        },
      ],
      next_steps: ["Fix the loop bound."],
    },
    null,
    2,
  ) +
  "\n```\n";

describe("extractLastJsonBlock", () => {
  it("extracts the fenced json block", () => {
    const block = extractLastJsonBlock(GOOD_BLOCK);
    expect(block).not.toBeNull();
    expect(block!).toContain('"verdict"');
  });
  it("returns the LAST block when several are present", () => {
    const reply = '```json\n{ "a": 1 }\n```\n' + "middle prose\n" + '```json\n{ "b": 2 }\n```\n';
    expect(JSON.parse(extractLastJsonBlock(reply)!)).toEqual({ b: 2 });
  });
  it("accepts a plain ``` block without the json tag", () => {
    expect(extractLastJsonBlock('```\n{ "x": 1 }\n```')).not.toBeNull();
  });
  it("returns null when no fenced block exists", () => {
    expect(extractLastJsonBlock("just prose, no code fence")).toBeNull();
  });
});

describe("validateReviewShape", () => {
  it("accepts a well-formed object", () => {
    expect(
      validateReviewShape({
        summary: "ok",
        findings: [{ severity: "high", title: "t", body: "b" }],
      }),
    ).toBeNull();
  });
  it("rejects a non-object", () => {
    expect(validateReviewShape("nope")).toMatch(/not an object/);
    expect(validateReviewShape(null)).toMatch(/not an object/);
    expect(validateReviewShape([])).toMatch(/not an object/);
  });
  it("rejects a missing/empty summary", () => {
    expect(validateReviewShape({ findings: [] })).toMatch(/summary/);
    expect(validateReviewShape({ summary: "  ", findings: [] })).toMatch(/summary/);
  });
  it("rejects non-array findings", () => {
    expect(validateReviewShape({ summary: "s", findings: "x" })).toMatch(/findings.*not an array/);
  });
  it("rejects a finding missing its title", () => {
    expect(
      validateReviewShape({ summary: "s", findings: [{ severity: "high", body: "b" }] }),
    ).toMatch(/title/);
  });
  it("does NOT strictly enforce severity enums (preserves unknown severities)", () => {
    // A severity outside the enum still surfaces usefully rather than failing.
    expect(
      validateReviewShape({
        summary: "s",
        findings: [{ severity: "blocker", title: "t", body: "b" }],
      }),
    ).toBeNull();
  });
});

describe("parseReviewOutput", () => {
  it("parses a valid block into structured findings", () => {
    const r = parseReviewOutput(GOOD_BLOCK);
    expect(r.parseError).toBeNull();
    expect(r.parsed).not.toBeNull();
    expect(r.parsed!.verdict).toBe("needs-attention");
    expect(r.parsed!.findings).toHaveLength(2);
    expect(r.parsed!.findings[0].severity).toBe("critical");
    expect(r.parsed!.findings[0].file).toBe("src/loop.ts");
    expect(r.parsed!.next_steps).toEqual(["Fix the loop bound."]);
    expect(r.rawOutput).toBe(GOOD_BLOCK);
  });

  it("returns parsed=null with no error when no block is present (unstructured)", () => {
    const r = parseReviewOutput("just prose, no structured block");
    expect(r.parsed).toBeNull();
    expect(r.parseError).toBeNull();
    expect(r.rawOutput).toBe("just prose, no structured block");
  });

  it("returns a parseError when the block has invalid JSON", () => {
    const r = parseReviewOutput("```json\n{ not valid json }\n```");
    expect(r.parsed).toBeNull();
    expect(r.parseError).toMatch(/failed to parse/i);
  });

  it("returns a parseError when the block is valid JSON but wrong shape", () => {
    const r = parseReviewOutput('```json\n{ "wrong": "shape" }\n```');
    expect(r.parsed).toBeNull();
    expect(r.parseError).toMatch(/shape invalid/i);
  });

  it("is total — never throws on garbage input", () => {
    expect(() => parseReviewOutput("")).not.toThrow();
    expect(() => parseReviewOutput("``````")).not.toThrow();
    expect(() => parseReviewOutput(undefined as never)).not.toThrow();
  });

  it("ignores trailing prose after the block", () => {
    const reply =
      '```json\n{ "summary": "s", "findings": [] }\n```\n' + "trailing prose after the block";
    const r = parseReviewOutput(reply);
    expect(r.parsed).not.toBeNull();
    expect(r.parsed!.summary).toBe("s");
  });
});

describe("REVIEW_JSON_INSTRUCTION", () => {
  it("documents the verdict + findings + next_steps shape", () => {
    expect(REVIEW_JSON_INSTRUCTION).toContain("verdict");
    expect(REVIEW_JSON_INSTRUCTION).toContain("findings");
    expect(REVIEW_JSON_INSTRUCTION).toContain("next_steps");
    expect(REVIEW_JSON_INSTRUCTION).toContain("```");
  });
});
