import path from "node:path";
import { z } from "zod";
import { REVIEW_JSON_INSTRUCTION } from "./review-output.js";

const OUTPUT_RULES =
  "Answer directly with no preamble or closing remarks. Be thorough but concise. " +
  "Cite file:line for every code-level finding.";

export function resolveFiles(files: string[], cwd: string): string[] {
  return files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)));
}

/**
 * Shared adversarial-review prompt framing for `adversarial_review` and
 * `pre_finish_review`. Pure: builds the prompt from already-resolved content.
 * The git-collection decision (when neither `content` nor `files` is given)
 * happens in the server handler, which calls this with the collected diff.
 */
export function buildReviewPrompt(
  args: Record<string, unknown>,
  cwd: string,
  toolName = "adversarial_review",
): string {
  const files = args.files as string[] | undefined;
  const inlineContent = args.content as string | undefined;
  if (!inlineContent && !files?.length) {
    throw new Error(`${toolName} requires \`content\`, \`files\`, or a git scope/base.`);
  }
  const subject = inlineContent
    ? `Review the following:\n\n${inlineContent}`
    : `Read and review these files:\n${resolveFiles(files!, cwd)
        .map((f) => `- ${f}`)
        .join("\n")}`;
  const focus = args.focus ? `\nFocus especially on: ${args.focus}.` : "";
  return (
    `You are an adversarial reviewer. Find real flaws: bugs, edge cases, security issues, ` +
    `performance traps, unstated assumptions, and simpler alternatives.${focus}\n\n${subject}\n\n` +
    `Rank findings by severity (critical/major/minor) and justify each. ` +
    `Do not pad with praise or restate the input. ${OUTPUT_RULES}\n\n${REVIEW_JSON_INSTRUCTION}`
  );
}

/**
 * Build a review prompt from git-collected context (Workstream A). Used by the
 * server handler when the caller passes neither `content` nor `files` — the
 * review then targets the working-tree or branch diff.
 */
export function buildGitReviewPrompt(
  ctx: {
    content: string;
    summary: string;
    inputMode: "inline-diff" | "self-collect";
    target: { label: string };
  },
  args: Record<string, unknown>,
): string {
  const focus = args.focus ? `\nFocus especially on: ${args.focus}.` : "";
  const selfCollectNote =
    ctx.inputMode === "self-collect"
      ? "The diff is large and was omitted — run your own read-only git commands (git diff, git log) to inspect the changes before reviewing.\n\n"
      : "";
  return (
    `You are an adversarial reviewer. Review the following git changes (${ctx.target.label}). ` +
    `Find real flaws: bugs, edge cases, security issues, performance traps, unstated assumptions, ` +
    `and simpler alternatives.${focus}\n\n${selfCollectNote}${ctx.summary}\n\n${ctx.content}\n\n` +
    `Rank findings by severity (critical/major/minor) and justify each. ` +
    `Do not pad with praise or restate the input. ${OUTPUT_RULES}\n\n${REVIEW_JSON_INSTRUCTION}`
  );
}

const commonShape = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute path to the working directory / project root. Defaults to the server's cwd.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Override the model. Accepts a canonical name from `agy models` (e.g. "Gemini 3.1 Pro ' +
        '(High)") OR a short alias: flash-low, flash-medium, flash-med, flash/flash-high, ' +
        "pro-low, pro/pro-high, sonnet, claude-sonnet, opus, claude-opus, gpt-oss, gpt-oss-120b. " +
        "Normally omit — the tool routes automatically.",
    ),
};

/**
 * Added to tools that support background execution (delegate / analyze_files /
 * deep_search / web_lookup). When true the handler returns a {job_id} at once
 * and runs agy detached; poll with job_status / job_result, cancel with
 * job_cancel. Absent/false keeps the existing synchronous path exactly as-is.
 */
const backgroundShape = {
  background: z
    .boolean()
    .optional()
    .describe(
      "If true, run this task in the background and return a {job_id} immediately instead of " +
        "awaiting the result. Poll with job_status / job_result; cancel with job_cancel. " +
        "Default false (synchronous — current behavior).",
    ),
};

/**
 * Per-call sandbox override. Accepted by every tool that spawns agy. When set,
 * wins over the AGY_SANDBOX global. Use true to keep agy read-only (no shell,
 * no writes) even when delegating a task you'd otherwise let roam.
 */
const sandboxShape = {
  sandbox: z
    .boolean()
    .optional()
    .describe(
      "Force agy's --sandbox on (true) or off (false) for this call, overriding AGY_SANDBOX. " +
        "Sandbox = read-only: agy can read files but cannot run shell commands or write.",
    ),
};

/**
 * Per-call write-capability shorthand for `delegate`. write=true drops the
 * sandbox AND enables --dangerously-skip-permissions so agy may edit files in
 * the cwd (a write run that stops to prompt would hang in headless mode).
 * write=false forces the sandbox on for safety.
 */
const writeShape = {
  write: z
    .boolean()
    .optional()
    .describe(
      "Only for delegate. true = agy may edit files (sandbox off, permissions auto-approved). " +
        "false = read-only (sandbox on). Default follows AGY_SANDBOX / the explicit `sandbox` arg.",
    ),
};

/**
 * Git review scoping (Workstream A). Added to adversarial_review and
 * pre_finish_review. When the caller passes neither `content` nor `files`,
 * the handler auto-collects a git diff: scope controls whether that's the
 * working tree or the current branch vs the default branch.
 */
const reviewShape = {
  scope: z
    .enum(["auto", "working-tree", "branch"])
    .optional()
    .describe(
      "When reviewing git changes (no inline content/files): 'auto' picks the working tree if " +
        "dirty, else the branch vs default; 'working-tree' reviews uncommitted changes; 'branch' " +
        "reviews the current branch against the detected default branch (main/master/trunk).",
    ),
  base: z
    .string()
    .optional()
    .describe(
      "Explicit git base ref for branch-scope review (e.g. 'main', 'origin/dev', a commit sha). " +
        "Overrides branch detection.",
    ),
};

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  chain: string[];
  /** Default --print-timeout for this tool, in seconds. AGY_TIMEOUT overrides. */
  timeoutSec: number;
  buildPrompt(args: Record<string, unknown>, cwd: string): string;
}

/** Tool names that accept the `background` flag (see backgroundShape). */
export const BACKGROUND_CAPABLE = new Set([
  "delegate",
  "analyze_files",
  "deep_search",
  "web_lookup",
]);

export const TOOLS: ToolDef[] = [
  {
    name: "analyze_files",
    description:
      "Delegate file analysis to the Antigravity CLI (Gemini) instead of reading files yourself. " +
      "USE THIS whenever a file is large (>200 lines) or the task spans more than 3 files: " +
      "logs, database dumps, generated code, cross-file reviews, comparisons. " +
      "The files never enter your context — only the answer does.",
    schema: {
      files: z
        .array(z.string())
        .min(1)
        .describe("File paths to analyze (relative to cwd or absolute)."),
      question: z.string().describe("What you want to know about these files."),
      ...commonShape,
      ...backgroundShape,
      ...sandboxShape,
    },
    chain: ["Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (Low)"],
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = resolveFiles(args.files as string[], cwd);
      return (
        `Read and analyze these files:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` +
        `Question: ${args.question}\n\n${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "deep_search",
    description:
      "Delegate codebase archaeology to the Antigravity CLI: git log/diff/blame spelunking, " +
      "wide greps across a repo, 'when/why did X change', 'where is Y used'. " +
      "USE THIS instead of running many search commands yourself — it saves your context.",
    schema: {
      query: z
        .string()
        .describe("What to find, e.g. 'when was the auth middleware refactored and why'."),
      ...commonShape,
      ...backgroundShape,
      ...sandboxShape,
    },
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 180,
    buildPrompt(args) {
      return (
        `Search this repository to answer the following. Use git log, git diff, git blame, ` +
        `and grep as needed.\n\nQuery: ${args.query}\n\n` +
        `Report findings with commit hashes where relevant. ${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "web_lookup",
    description:
      "Delegate a web/documentation lookup to the Antigravity CLI (Gemini with web access): " +
      "library docs, API references, error messages, current versions, external knowledge. " +
      "USE THIS when you need information you don't have or that may be newer than your training data.",
    schema: {
      query: z.string().describe("What to look up on the web."),
      ...commonShape,
      ...backgroundShape,
      ...sandboxShape,
    },
    chain: ["Gemini 3.5 Flash (Medium)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 120,
    buildPrompt(args) {
      return `Look up on the web: ${args.query}\n\nInclude source URLs for key claims. ${OUTPUT_RULES}`;
    },
  },
  {
    name: "adversarial_review",
    description:
      "Get an adversarial second opinion from a different model family (Gemini Pro). " +
      "ALWAYS use this for plan critiques, design reviews, and pre-merge code review: " +
      "it hunts for flaws, edge cases, security issues, and unstated assumptions you may have missed. " +
      "Pass `content` (inline) or `files` (paths) to review specific text; OR pass neither plus a " +
      "`scope`/`base` to auto-review the current git diff (working-tree or branch). Returns a " +
      "structured severity-ranked finding list (parsed JSON) plus the full prose review.",
    schema: {
      content: z
        .string()
        .optional()
        .describe("Inline content to review (plan, diff, code snippet)."),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'security', 'concurrency'."),
      ...reviewShape,
      ...commonShape,
      ...sandboxShape,
    },
    chain: ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 300,
    buildPrompt: (args, cwd) => buildReviewPrompt(args, cwd),
  },
  {
    name: "pre_finish_review",
    description:
      "Get an adversarial pre-finish review of work-in-progress BEFORE declaring a task " +
      "complete. ALWAYS call this tool before you report a task as done / fixed / passing: it " +
      "hunts for bugs, edge cases, security issues, performance traps, and unstated assumptions " +
      "that a second model family catches and you may have missed. Pass `content` (inline " +
      "diff/plan/code/snippet) or `files` (paths to review), plus an optional `focus`; OR pass " +
      "neither plus a `scope`/`base` to auto-review the current git diff. Returns findings as a " +
      "structured severity-ranked list (parsed JSON) plus the full prose review — advisory and " +
      "NON-blocking; weigh them with judgement, they do not gate completion.",
    schema: {
      content: z
        .string()
        .optional()
        .describe("Inline content to review (plan, diff, code snippet)."),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'security', 'concurrency'."),
      ...reviewShape,
      ...commonShape,
      ...sandboxShape,
    },
    chain: ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", "Gemini 3.5 Flash (High)"],
    timeoutSec: 300,
    buildPrompt: (args, cwd) => buildReviewPrompt(args, cwd, "pre_finish_review"),
  },
  {
    name: "follow_up",
    description:
      "Continue a previous Antigravity session by session_id (returned by every other tool). " +
      "USE THIS for follow-up questions about a prior delegation — the full prior context " +
      "is already on agy's side, so you don't resend anything.",
    schema: {
      session_id: z.string().describe("The session id returned by a previous agy-bridge call."),
      question: z.string().describe("The follow-up question."),
      ...commonShape,
    },
    chain: [],
    timeoutSec: 300,
    buildPrompt(args) {
      return args.question as string;
    },
  },
  {
    name: "delegate",
    description:
      "Raw delegation to the Antigravity CLI for heavy tasks that don't fit the other tools. " +
      "agy has full tool access (shell, file reads, web) in the given cwd.",
    schema: {
      prompt: z.string().describe("The complete task prompt for agy."),
      ...commonShape,
      ...backgroundShape,
      ...sandboxShape,
      ...writeShape,
    },
    chain: ["Gemini 3.5 Flash (High)"],
    timeoutSec: 600,
    buildPrompt(args) {
      return args.prompt as string;
    },
  },
  {
    name: "agy_look",
    description:
      "Look at one or more EXISTING images and answer questions about them by delegating to a " +
      "vision-capable Antigravity model (Gemini). USE THIS when the host agent cannot see images " +
      "(e.g. a text-only model) and needs to understand a screenshot, diagram, chart, photo, UI " +
      "mockup, or error dialog — pass the file path(s) and what you want to know, and only the " +
      "answer enters the host's context. Distinct from image_gen (which GENERATES images) and " +
      "analyze_files (which reads TEXT/code). Uses agy's @<path> file-attachment convention.",
    schema: {
      image_path: z
        .union([z.string(), z.array(z.string()).min(1)])
        .describe(
          "Absolute or cwd-relative path(s) to the image(s) to inspect. PNG, JPEG, WEBP, GIF.",
        ),
      question: z
        .string()
        .describe(
          "What you want to know about the image(s), e.g. 'describe this UI' or 'read the error'.",
        ),
      ...commonShape,
      ...sandboxShape,
    },
    chain: ["Gemini 3.5 Flash (High)", "Gemini 3.1 Pro (High)", "Gemini 3.5 Flash (Medium)"],
    timeoutSec: 180,
    buildPrompt(args, cwd) {
      const raw = args.image_path as string | string[];
      const paths = (Array.isArray(raw) ? raw : [raw]).map((f) => resolveFiles([f], cwd)[0]);
      const attach = paths.map((p) => `@${p}`).join(" ");
      return (
        `Look at the attached image(s) and answer the question. Be precise and concrete; cite "image 1", ` +
        `"image 2", etc. when there are several. ${OUTPUT_RULES}\n\nImages: ${attach}\n\nQuestion: ${args.question}`
      );
    },
  },
  {
    name: "image_gen",
    description:
      "Generate an image via the Antigravity CLI's built-in generate_image tool (Imagen). " +
      "Returns the saved image path (text) PLUS an MCP image content block so a vision-capable " +
      "agent can inspect the generated asset; pass `output` to also copy the file to a target " +
      "path (e.g. for embedding in HTML/PPTX). agy is instructed to END its reply with a single " +
      "`IMAGE_PATH: <absolute path>` line — when it omits that marker the bridge falls back to " +
      "scraping an absolute image path, and when neither is found it returns the reply text plus " +
      "a clear warning instead of guessing a path. Relies on the prompt contract; does NOT call " +
      "agy's generate_image directly.",
    schema: {
      description: z.string().describe("What the image should depict."),
      name: z
        .string()
        .optional()
        .describe(
          'Slug used as the saved image filename (passed to agy as "Save the image with name ' +
            '\\"<slug>\\".").',
        ),
      output: z
        .string()
        .optional()
        .describe("Optional absolute path to copy the generated image to."),
      ...commonShape,
    },
    chain: ["Gemini 3.5 Flash (High)", "Gemini 3.5 Flash (Medium)"],
    timeoutSec: 300,
    buildPrompt(args) {
      const description = args.description as string;
      const slug = args.name as string | undefined;
      const nameClause = slug ? ` Save the image with name "${slug}".` : "";
      return (
        `Use your built-in generate_image tool to create the following image. ` +
        `Description: ${description}.${nameClause}\n\n` +
        `After the tool returns, you MUST end your reply with a single line in this exact format ` +
        `(no quotes, no markdown, nothing after it):\n` +
        `IMAGE_PATH: <absolute filesystem path to the saved image>\n\n` +
        `The IMAGE_PATH line is required — the calling wrapper parses it to locate the file.`
      );
    },
  },
];

/**
 * session_transfer does NOT run agy. It resolves the conversation id stored in
 * agy's local sessions cache and returns a resume command. Registered with a
 * custom (non-runAgy) handler in server.ts, so chain/timeoutSec/buildPrompt are
 * not exercised — they only satisfy the ToolDef shape.
 */
export const SESSION_TRANSFER_TOOL: ToolDef = {
  name: "session_transfer",
  description:
    "Resolve the Antigravity CLI (agy) conversation id for a working directory and return a " +
    "resume command (`agy --conversation <id>`) so a session can be handed off or continued in a " +
    "terminal. Reads agy's local sessions cache; makes NO agy run. Returns session_id null when " +
    "no conversation is recorded for the cwd.",
  schema: { cwd: commonShape.cwd },
  chain: [],
  timeoutSec: 0,
  buildPrompt: () => "",
};

export interface SessionTransferResult {
  session_id: string | null;
  resume_command: string | null;
}

/**
 * Pure resolver over agy's last_conversations.json (keyed by resolved cwd path,
 * mirroring runner.ts session-map read). Returns a null session_id — never throws —
 * when the map is missing, empty, unparseable, or has no entry for the cwd.
 */
export function resolveSessionTransfer(mapJson: string, cwd: string): SessionTransferResult {
  let map: Record<string, string>;
  try {
    const parsed = JSON.parse(mapJson);
    if (!parsed || typeof parsed !== "object") {
      return { session_id: null, resume_command: null };
    }
    map = parsed as Record<string, string>;
  } catch {
    return { session_id: null, resume_command: null };
  }
  const id = map[path.resolve(cwd)];
  if (!id) return { session_id: null, resume_command: null };
  return { session_id: id, resume_command: `agy --conversation ${id}` };
}

/**
 * Result of parsing an agy image_gen reply for the saved-image path.
 * `srcPath` is null when neither the IMAGE_PATH marker nor a confidently
 * absolute image path is present (deterministic default — no guessing).
 */
export interface ImageGenParse {
  srcPath: string | null;
  /** True when found via the `IMAGE_PATH:` marker; false when scraped. */
  viaMarker: boolean;
}

/**
 * Pure parser over an agy image_gen reply. Mirrors references/.../agy-run.sh
 * cmd_image: primary = the LAST line matching `^\s*IMAGE_PATH:\s*(.+?)\s*$`;
 * fallback = scrape an absolute image path (Windows-drive form first, then
 * POSIX), tolerating BOTH `\` and `/` separators and spaces in paths. Returns
 * null srcPath when neither yields a confident absolute path.
 */
export function parseImageGenReply(reply: string): ImageGenParse {
  // Primary: scan lines bottom-up for the last IMAGE_PATH: marker.
  const lines = reply.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*IMAGE_PATH:\s*(.+?)\s*$/);
    if (m) {
      const p = m[1].trim();
      if (p) return { srcPath: p, viaMarker: true };
    }
  }
  // Fallback: Windows-drive absolute path (tolerates \ and /, spaces).
  const win = reply.match(/[A-Za-z]:[\\/][^\n\r]*?\.(?:png|jpe?g|webp)/);
  if (win) return { srcPath: win[0].trim(), viaMarker: false };
  // Fallback: POSIX absolute path.
  const posix = reply.match(/\/[^\n\r]+?\.(?:png|jpe?g|webp)/);
  if (posix) return { srcPath: posix[0].trim(), viaMarker: false };
  return { srcPath: null, viaMarker: false };
}

/** MIME type from a file extension for an MCP image content block. */
export function mimeTypeFor(filePath: string): string {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
