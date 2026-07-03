/**
 * Parse the structured JSON block agy is asked to emit at the end of a review.
 *
 * Mirrors codex-plugin-cc's parseStructuredOutput contract: the review prompt
 * instructs agy to END its reply with a fenced ```json block conforming to
 * schemas/review-output.schema.json. This module extracts the LAST such block
 * (agy sometimes adds trailing prose), validates the minimal shape, and returns
 * a deterministic result — never throws.
 *
 * Deliberately avoids adding a JSON-schema validator dependency: the schema is
 * small and stable, so a hand-written shape check is enough and keeps the npm
 * footprint minimal. If agy omits the block or emits malformed JSON, the caller
 * still gets the raw text to display.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type Verdict = "approve" | "needs-attention";

export interface ReviewFinding {
  severity: Severity | string;
  title: string;
  body: string;
  file?: string;
  line_start?: number;
  line_end?: number;
  confidence?: number;
  recommendation?: string;
}

export interface ReviewOutput {
  verdict?: Verdict | string;
  summary?: string;
  findings: ReviewFinding[];
  next_steps?: string[];
}

export interface ParsedReview {
  /** The structured object when extraction + validation succeeded. */
  parsed: ReviewOutput | null;
  /** The full raw reply text (for display when parsing fails). */
  rawOutput: string;
  /** Set when a block was found but failed validation; null on success or when no block found. */
  parseError: string | null;
}

/**
 * Extract the last fenced ```json (or ```) block from the reply. Scans
 * bottom-up so trailing prose after a valid block doesn't matter. Returns the
 * block's inner text, or null when no fenced block is present.
 */
export function extractLastJsonBlock(reply: string): string | null {
  const blocks: { start: number; end: number; body: string }[] = [];
  // Match ```json ... ``` or ``` ... ``` (non-greedy, multiline).
  const re = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) {
    blocks.push({ start: m.index, end: re.lastIndex, body: m[1] });
  }
  if (blocks.length === 0) return null;
  return blocks[blocks.length - 1].body;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Minimal shape validation against schemas/review-output.schema.json. Checks the
 * required fields and the types of their values; does NOT enforce enum values
 * (severity/verdict) strictly — instead they're preserved as-is so an agy that
 * returns a slightly different severity ("blocker") still surfaces usefully.
 * Returns null when valid, or a human description of what's wrong.
 */
export function validateReviewShape(obj: unknown): string | null {
  if (!isObject(obj)) return "top-level value is not an object";
  if (typeof obj.summary !== "string" || obj.summary.trim() === "") {
    return "missing or empty `summary` string";
  }
  if (!Array.isArray(obj.findings)) return "`findings` is not an array";
  for (let i = 0; i < obj.findings.length; i++) {
    const f = obj.findings[i];
    if (!isObject(f)) return `findings[${i}] is not an object`;
    if (typeof f.severity !== "string") return `findings[${i}].severity is not a string`;
    if (typeof f.title !== "string" || f.title.trim() === "") {
      return `findings[${i}] missing title`;
    }
    if (typeof f.body !== "string") return `findings[${i}].body is not a string`;
  }
  return null;
}

/**
 * Parse a review reply into a structured result. Deterministic and total:
 * never throws. When the block is absent or malformed, `parsed` is null and the
 * caller falls back to displaying `rawOutput`.
 */
export function parseReviewOutput(reply: string): ParsedReview {
  const rawOutput = String(reply ?? "");
  const block = extractLastJsonBlock(rawOutput);
  if (block === null) {
    return {
      parsed: null,
      rawOutput,
      parseError: null, // no block found — not an error, just unstructured
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch (e) {
    return {
      parsed: null,
      rawOutput,
      parseError: `found a fenced JSON block but it failed to parse: ${(e as Error).message}`,
    };
  }
  const shapeError = validateReviewShape(data);
  if (shapeError) {
    return { parsed: null, rawOutput, parseError: `block parsed but shape invalid: ${shapeError}` };
  }
  return { parsed: data as ReviewOutput, rawOutput, parseError: null };
}

/**
 * The instruction appended to review prompts asking agy to emit the structured
 * block. Kept here so the schema and the instruction stay in sync.
 */
export const REVIEW_JSON_INSTRUCTION =
  "After your prose analysis, you MUST end your reply with a single fenced ```json block " +
  "(and nothing after it) conforming exactly to this shape:\n" +
  "```json\n" +
  "{\n" +
  '  "verdict": "approve" | "needs-attention",\n' +
  '  "summary": "<one-paragraph headline>",\n' +
  '  "findings": [\n' +
  '    { "severity": "critical"|"high"|"medium"|"low", "title": "...", "body": "...",\n' +
  '      "file": "<optional path>", "line_start": <optional int>, "line_end": <optional int>,\n' +
  '      "confidence": <0..1>, "recommendation": "..." }\n' +
  "  ],\n" +
  '  "next_steps": ["<optional action>", "..."]\n' +
  "}\n" +
  "```\n" +
  "The JSON block is required — the calling wrapper parses it to summarize your review.";
