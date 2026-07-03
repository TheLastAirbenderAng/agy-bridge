import { describe, it, expect } from "vitest";
import { extractDelta } from "../src/delta.js";

describe("extractDelta", () => {
  it("returns the full text when there is no previous output", () => {
    expect(extractDelta("", "the answer")).toBe("the answer");
    expect(extractDelta(undefined as never, "the answer")).toBe("the answer");
  });

  it("returns the full text when both are empty", () => {
    expect(extractDelta("", "")).toBe("");
  });

  it("slices the previous prefix off (stage 1: startsWith)", () => {
    const prev = "Hello.\n\nThis is the prior turn.";
    const full = `${prev}\n\nAnd here is the new answer.`;
    expect(extractDelta(prev, full)).toBe("And here is the new answer.");
  });

  it("normalizes CRLF before matching (stage 1)", () => {
    const prev = "Line one\r\nLine two";
    const full = "Line one\nLine two\r\nLine three";
    expect(extractDelta(prev, full)).toBe("Line three");
  });

  it("tolerates trailing-whitespace drift (stage 2: trimEnd)", () => {
    const prev = "prior turn   \n\n  ";
    const full = "prior turn\n\nnew bit";
    expect(extractDelta(prev, full)).toBe("new bit");
  });

  it("finds the replay after a header via indexOf (stage 3)", () => {
    // agy may print "Resuming conversation X..." before replaying history.
    const prev = "Old question.\nOld answer.";
    const full = `Resuming conversation abc-123.\n\n${prev}\n\nNew answer.`;
    expect(extractDelta(prev, full)).toBe("New answer.");
  });

  it("uses a last-line suffix match when the prefix drifts (stage 4)", () => {
    const prev = "Some preamble that changed.\nMore context.\nA distinctive last line.";
    // The full text has a different preamble but the same last line + new content.
    const full = "Different preamble.\nA distinctive last line.\nThe genuinely new turn.";
    const delta = extractDelta(prev, full);
    expect(delta).toContain("The genuinely new turn");
  });

  it("falls back to the full text when no alignment is possible (stage 5)", () => {
    const prev = "completely unrelated content with no overlapping lines at all";
    const full = "totally different text that shares nothing";
    // Stage 5 returns the whole thing rather than dropping it.
    expect(extractDelta(prev, full)).toBe(full);
  });

  it("never returns empty when fullText is non-empty", () => {
    expect(extractDelta("anything", "non-empty reply")).not.toBe("");
  });
});
