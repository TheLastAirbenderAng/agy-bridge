import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { ModelRegistry, resolveModelAlias } from "./models.js";
import { collectReviewContext, defaultGitExec, type GitExec, type ReviewScope } from "./git.js";
import { parseReviewOutput } from "./review-output.js";
import { extractDelta } from "./delta.js";
import { defaultSessionStore, type SessionStore } from "./session-store.js";
import { sniffImageFormat } from "./sniff.js";
import {
  runAgy,
  defaultDeps,
  execWithClosedStdin,
  SESSIONS_FILE,
  type RunnerDeps,
  type RunResult,
  type RunRequest,
  type TreeKillExecFn,
  defaultTreeKillExec,
} from "./runner.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import { AgyRunError } from "./errors.js";
import {
  TOOLS,
  SESSION_TRANSFER_TOOL,
  BACKGROUND_CAPABLE,
  resolveSessionTransfer,
  parseImageGenReply,
  mimeTypeFor,
  buildGitReviewPrompt,
  type ToolDef,
} from "./tools.js";
import {
  runAgyBackground,
  cancelJob,
  scanOrphans,
  waitForJob,
  createJobStore,
  defaultJobStore,
  type JobStore,
} from "./jobs.js";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ContentBlock = TextBlock | ImageBlock;

/**
 * Default GitExec for review tools: wraps the real `git` binary via
 * execWithClosedStdin. Injectable through createToolHandler so the git
 * collection path is unit-testable without a repo.
 */
const defaultGitExecExecFn: GitExec = defaultGitExec(execWithClosedStdin);

interface ToolResponse {
  [key: string]: unknown;
  content: ContentBlock[];
  isError?: boolean;
}

/**
 * Filesystem hooks for image_gen post-processing. Injectable so the pure
 * parse + footer logic is testable without touching real files; defaults read
 * + copy real files. Both gracefully degrade (text-only) on failure.
 */
export interface ImageGenDeps {
  copyFile(src: string, dest: string): Promise<void>;
  readFileBytes(p: string): Promise<Buffer>;
}

export const defaultImageGenDeps: ImageGenDeps = {
  copyFile: (src, dest) => copyFile(src, dest),
  readFileBytes: (p) => readFile(p),
};

interface HandlerExtra {
  signal?: AbortSignal;
}

/**
 * Spawns a detached background run and returns its job id immediately.
 * Injectable so the background branch is unit-testable without touching agy.
 */
export type BackgroundRunner = (
  req: RunRequest,
  cfg: Config,
  deps: RunnerDeps,
  store: JobStore,
) => Promise<string>;

export const defaultBackgroundRunner: BackgroundRunner = (req, cfg, deps, store) =>
  runAgyBackground(req, cfg, deps, store);

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  registry: ModelRegistry,
  deps: RunnerDeps = defaultDeps,
  cooldowns: CooldownRegistry = new CooldownRegistry(),
  imageGenDeps: ImageGenDeps = defaultImageGenDeps,
  jobStore: JobStore = defaultJobStore,
  backgroundRunner: BackgroundRunner = defaultBackgroundRunner,
  gitExec: GitExec = defaultGitExecExecFn,
  sessionStore: SessionStore = defaultSessionStore,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();
      // Workstream B: resume-latest. When follow_up is called with no
      // session_id, resolve the most recent session for this cwd from the
      // persisted store (mirrors codex --resume-last). Falls back to undefined
      // (single-turn) when none is recorded.
      let conversationId = args.session_id as string | undefined;
      if (!conversationId && tool.name === "follow_up") {
        const entry = await sessionStore.get(cwd);
        conversationId = entry?.conversationId;
      }
      // For delta extraction on follow_up: capture the prior output before the run.
      const prevOutputForDelta =
        tool.name === "follow_up" ? (await sessionStore.get(cwd))?.prevOutput : undefined;
      const timeoutSec =
        cfg.perToolTimeouts[tool.name] ?? (cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec);
      // Resolve a user-supplied alias ("flash", "opus", ...) to its canonical
      // agy model string. Passes canonical strings and undefined through;
      // throws UnknownModelAliasError on a typo (surfaced as isError below).
      const explicitModel = resolveModelAlias(args.model as string | undefined);
      // Per-call sandbox/write shorthand (Workstream C). `write` only exists on
      // `delegate`; `sandbox` is accepted by the read-only delegators too.
      const sandbox = args.sandbox as boolean | undefined;
      const write = args.write as boolean | undefined;

      // Workstream A: git-aware review. When a review tool is called with no
      // inline content/files, auto-collect the git diff (working-tree or branch)
      // and build the prompt from it. `gitReview` marks the run so the response
      // is parsed for structured findings below.
      let prompt: string;
      let gitReview = false;
      const isReviewTool = tool.name === "adversarial_review" || tool.name === "pre_finish_review";
      const hasInline =
        Boolean(args.content) || Boolean((args.files as string[] | undefined)?.length);
      if (isReviewTool && !hasInline) {
        const ctx = await collectReviewContext(cwd, gitExec, {
          scope: args.scope as ReviewScope | undefined,
          base: args.base as string | undefined,
        });
        prompt = buildGitReviewPrompt(ctx, args);
        gitReview = true;
      } else {
        prompt = tool.buildPrompt(args, cwd);
      }

      // Background path: spawn detached, return a job id at once (no await on agy).
      if (args.background === true && BACKGROUND_CAPABLE.has(tool.name)) {
        const jobId = await backgroundRunner(
          { prompt, cwd, model: explicitModel, conversationId, timeoutSec, sandbox, write },
          cfg,
          deps,
          jobStore,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  job_id: jobId,
                  status: "running",
                  message:
                    "Task started in the background. Poll with job_status / job_result; " +
                    "cancel with job_cancel.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const resolution = conversationId
        ? { models: [undefined], note: undefined }
        : await registry.resolveChain({
            explicit: explicitModel,
            chain: tool.chain,
            defaultModel: cfg.defaultModel,
          });

      const attempts: string[] = [];
      let result: RunResult | undefined;
      let used: string | undefined;

      for (const model of resolution.models) {
        if (model && cooldowns.cooling(model)) {
          attempts.push(`${model}: quota cooldown, ${cooldowns.describe(model)} left`);
          continue;
        }
        try {
          result = await runAgy(
            {
              prompt,
              cwd,
              model,
              conversationId,
              timeoutSec,
              signal: extra?.signal,
              sandbox,
              write,
            },
            cfg,
            deps,
          );
          used = model;
          break;
        } catch (err) {
          if (err instanceof QuotaError && model) {
            cooldowns.set(model, err.resetSeconds);
            attempts.push(
              `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
            );
            continue;
          }
          throw err;
        }
      }

      if (!result) {
        throw new Error(
          `All candidate models are quota-exhausted or cooling down:\n` +
            `${attempts.map((a) => `- ${a}`).join("\n")}\n` +
            `Retry after the quota resets, or pass an explicit \`model\`.`,
        );
      }

      const meta: string[] = [`model: ${used ?? "agy default"}`];
      if (resolution.note) meta.push(`note: ${resolution.note}`);
      if (attempts.length) meta.push(`failover: ${attempts.join("; ")}`);

      // Workstream B: delta extraction + session persistence for multi-turn.
      // follow_up replays the whole transcript on agy's side; extract only the
      // new turn so the host doesn't re-read the entire history. Then persist
      // {conversationId, output} for the cwd so a restart or a resume-latest
      // follow_up continues seamlessly. Fire-and-forget the persist so it can't
      // block the response; failures are swallowed (multi-turn is best-effort).
      let output = result.output;
      if (tool.name === "follow_up" && prevOutputForDelta && conversationId) {
        const delta = extractDelta(prevOutputForDelta, result.output);
        if (delta) {
          output = delta;
          meta.push("delta: extracted new turn only");
        }
      }
      if (result.sessionId) {
        meta.push(`session: ${result.sessionId} (use follow_up to continue)`);
        void sessionStore
          .set(cwd, {
            conversationId: result.sessionId,
            prevOutput: output,
            updatedAt: new Date().toISOString(),
          })
          .catch(() => {});
      }
      const deltaResult = { ...result, output };

      if (tool.name === "image_gen") {
        return buildImageGenResponse(deltaResult, args, meta, imageGenDeps);
      }

      // Workstream A: parse the structured JSON block from git-collected
      // reviews. Prepends a one-line verdict/finding summary so the host gets
      // an actionable headline; the full prose + JSON remain below unchanged.
      if (gitReview) {
        const parsed = parseReviewOutput(deltaResult.output);
        if (parsed.parsed) {
          const p = parsed.parsed;
          const sevCounts = p.findings.reduce<Record<string, number>>((acc, f) => {
            const s = String(f.severity ?? "unknown");
            acc[s] = (acc[s] ?? 0) + 1;
            return acc;
          }, {});
          const countsStr = Object.entries(sevCounts)
            .map(([sev, n]) => `${sev}: ${n}`)
            .join(", ");
          meta.unshift(
            `verdict: ${p.verdict ?? "?"}`,
            `findings: ${p.findings.length} (${countsStr})`,
          );
        } else if (parsed.parseError) {
          meta.push(`structured parse: ${parsed.parseError}`);
        }
      }

      return {
        content: [
          { type: "text", text: `${deltaResult.output}\n\n---\n[agy-bridge] ${meta.join(" | ")}` },
        ],
      };
    } catch (err) {
      let text = (err as Error).message;
      // Surface the structured error kind (geo-blocked / rate-limit / auth /
      // safety / not-installed) as a footer so the host model gets an
      // actionable signal instead of guessing from raw text.
      if (err instanceof AgyRunError) {
        text += `\n\n[agy-bridge error kind: ${err.kind}]`;
      }
      if (cfg.onFailure === "strict") {
        text +=
          "\n\n[agy-bridge strict mode] Delegation failed. Do NOT perform this work yourself " +
          "in the main context — report the failure to the user and let them decide how to proceed.";
      }
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }
  };
}

/**
 * image_gen post-processing: parse the IMAGE_PATH contract (marker, then a
 * Windows-safe absolute-path scrape), optionally copy to `output`, and attach
 * an MCP image content block. Deterministic default: when no marker AND no
 * confident absolute path is found, returns the reply text plus a WARNING and
 * attaches no image block — never guesses a path. Mirrors references/.../
 * agy-run.sh cmd_image (parse + fallback + copy pattern).
 */
export async function buildImageGenResponse(
  result: RunResult,
  args: Record<string, unknown>,
  meta: string[],
  deps: ImageGenDeps = defaultImageGenDeps,
): Promise<ToolResponse> {
  const parsed = parseImageGenReply(result.output);
  const output = args.output as string | undefined;
  const footer = [...meta];
  const content: ContentBlock[] = [];

  if (parsed.srcPath) {
    footer.push(`image_path: ${parsed.srcPath}`);
    footer.push(
      parsed.viaMarker ? "parsed via: IMAGE_PATH marker" : "parsed via: fallback path scrape",
    );
    if (output) {
      try {
        await deps.copyFile(parsed.srcPath, output);
        footer.push(`copied to: ${output}`);
      } catch (err) {
        footer.push(`copy to ${output} failed: ${(err as Error).message}`);
      }
    }
    try {
      const bytes = await deps.readFileBytes(parsed.srcPath);
      // Sniff the real byte format — agy returns JPEG regardless of the
      // requested extension (oh-my-agent finding). Trust bytes over the path
      // extension so a vision host decodes the block correctly.
      const sniffed = sniffImageFormat(bytes);
      const mime = sniffed.ext === "bin" ? mimeTypeFor(parsed.srcPath) : sniffed.mime;
      if (sniffed.ext !== "bin") {
        const pathExt = parsed.srcPath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
        if (sniffed.ext !== pathExt) {
          footer.push(`format sniff: bytes are ${sniffed.ext} (path says ${pathExt || "?"})`);
        }
      }
      content.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: mime,
      });
    } catch {
      footer.push("image block skipped: file unreadable");
    }
  } else {
    footer.push(
      "WARNING: agy did not include an IMAGE_PATH line and no absolute image path was " +
        "found in its reply. No image was copied or attached.",
    );
  }

  content.unshift({
    type: "text",
    text: `${result.output}\n\n---\n[agy-bridge] ${footer.join(" | ")}`,
  });
  return { content };
}

type AuthStatus = "api-key" | "oauth" | "missing" | "unknown";

/**
 * Mirrors references/antigravity-plugin-cc/.../agy-run.sh:31-39 (auth_status).
 * Heuristic only — the real token lives inside the closed agy binary, not the
 * environment; this probe is kept local (config.ts reads NO auth var).
 */
function detectAuth(): AuthStatus {
  if (process.env.ANTIGRAVITY_API_KEY) return "api-key";
  const home = homedir();
  if (
    existsSync(path.join(home, ".config", "antigravity")) ||
    existsSync(path.join(home, ".gemini", "antigravity-cli"))
  ) {
    return "oauth";
  }
  return "missing";
}

type VersionExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * `setup` health-check tool — runs `agy --version` only (NO `-p`, no model call).
 * Returns JSON { installed, path, version, auth, error } mirroring agy-run.sh
 * cmd_check. Registered OUTSIDE the runAgy loop.
 */
export function createSetupHandler(
  cfg: Config,
  execVersion: VersionExecFn = (file, args) =>
    execWithClosedStdin(file, args, {
      cwd: process.cwd(),
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }),
): (args: Record<string, unknown>) => Promise<ToolResponse> {
  return async () => {
    let installed = true;
    let version = "";
    let auth: AuthStatus = "unknown";
    let error = "";
    try {
      const { stdout } = await execVersion(cfg.agyPath, ["--version"]);
      version = (stdout.trim().split(/\r?\n/)[0] ?? "").trim();
      auth = detectAuth();
    } catch (err) {
      installed = false;
      auth = "unknown";
      const e = err as NodeJS.ErrnoException;
      error =
        e?.code === "ENOENT"
          ? `agy binary not found at "${cfg.agyPath}"; install with: curl -fsSL https://antigravity.google/cli/install.sh | bash`
          : (e?.message ?? String(err));
    }
    const payload = {
      installed,
      path: installed ? cfg.agyPath : "",
      version,
      auth,
      error,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  };
}

type SessionsReader = () => Promise<string>;

/**
 * `session_transfer` — resolves the agy conversation id for a cwd from agy's
 * sessions cache and returns the id + a resume command. Makes NO agy run.
 * Missing/empty/unparseable cache → session_id null (never throws).
 */
export function createSessionTransferHandler(
  readSessions: SessionsReader = () => readFile(SESSIONS_FILE, "utf8"),
): (args: Record<string, unknown>) => Promise<ToolResponse> {
  return async (args) => {
    const cwd = (args.cwd as string | undefined) ?? process.cwd();
    let mapJson = "";
    try {
      mapJson = await readSessions();
    } catch {
      mapJson = ""; // missing/empty cache → session_id null, no throw
    }
    const { session_id, resume_command } = resolveSessionTransfer(mapJson, cwd);
    const lines: string[] = [];
    if (session_id) {
      lines.push(`session_id: ${session_id}`);
      lines.push(`resume_command: ${resume_command}`);
      lines.push("");
      lines.push("Run the resume command in a terminal to continue this agy conversation.");
    } else {
      lines.push("session_id: null");
      lines.push(`No agy conversation recorded for: ${path.resolve(cwd)}`);
      lines.push("Run agy once in this directory to start a conversation.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  };
}

/**
 * `job_status` — returns a job's status (and timing) by id. Never throws:
 * an unknown id yields an isError response with a clear message. When `wait`
 * is true, polls until the job leaves queued/running or the timeout elapses
 * (Workstream B, mirrors codex --wait). Surfaces `partialOutput` while a job
 * is still running so the host gets a progress signal.
 */
export function createJobStatusHandler(
  store: JobStore = defaultJobStore,
): (args: Record<string, unknown>) => Promise<ToolResponse> {
  return async (args) => {
    const id = args.id as string;
    if (args.wait === true) {
      const { job, waitTimedOut } = await waitForJob(id, store, {
        timeoutMs: (args.timeout_ms as number | undefined) ?? undefined,
        pollMs: (args.poll_ms as number | undefined) ?? undefined,
      });
      if (!job) {
        return {
          content: [{ type: "text", text: `Error: unknown job id "${id}".` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: job.id,
                status: job.status,
                phase: job.phase,
                startedAt: job.startedAt,
                endedAt: job.endedAt,
                waitTimedOut,
                ...(job.status === "running" && job.partialOutput
                  ? { partialOutput: job.partialOutput }
                  : {}),
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    const job = await store.get(id);
    if (!job) {
      return {
        content: [{ type: "text", text: `Error: unknown job id "${id}".` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: job.id,
              status: job.status,
              phase: job.phase,
              startedAt: job.startedAt,
              endedAt: job.endedAt,
              ...(job.status === "running" && job.partialOutput
                ? { partialOutput: job.partialOutput }
                : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  };
}

/**
 * `job_result` — returns the stored output for a finished job. `running` jobs
 * return a `{status:"running"}` poll marker; `done` returns the agy output
 * plus a session footer; `failed`/`cancelled` return their reason.
 */
export function createJobResultHandler(
  store: JobStore = defaultJobStore,
): (args: Record<string, unknown>) => Promise<ToolResponse> {
  return async (args) => {
    const id = args.id as string;
    const job = await store.get(id);
    if (!job) {
      return {
        content: [{ type: "text", text: `Error: unknown job id "${id}".` }],
        isError: true,
      };
    }
    if (job.status === "done") {
      const footer = job.conversationId
        ? `\n\n---\n[agy-bridge] session: ${job.conversationId} (use follow_up to continue)`
        : "";
      return { content: [{ type: "text", text: `${job.output ?? ""}${footer}` }] };
    }
    if (job.status === "failed") {
      return {
        content: [{ type: "text", text: `Job ${job.id} failed: ${job.error ?? "unknown error"}` }],
        isError: true,
      };
    }
    if (job.status === "cancelled") {
      return { content: [{ type: "text", text: `Job ${job.id} was cancelled.` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ id: job.id, status: "running" }) }] };
  };
}

/**
 * `job_cancel` — tree-kills a running job's pid and marks it cancelled.
 * Idempotent: cancelling an already-done/failed/cancelled job is a no-op that
 * returns the current status. treeKill's exec is injectable for testing.
 */
export function createJobCancelHandler(
  store: JobStore = defaultJobStore,
  exec: TreeKillExecFn = defaultTreeKillExec,
): (args: Record<string, unknown>) => Promise<ToolResponse> {
  return async (args) => {
    const id = args.id as string;
    try {
      const { cancelled, status } = await cancelJob(id, store, { exec });
      return { content: [{ type: "text", text: JSON.stringify({ id, cancelled, status }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: (err as Error).message }], isError: true };
    }
  };
}

export function createServer(): McpServer {
  const cfg = loadConfig();
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execWithClosedStdin(cfg.agyPath, ["models"], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  });
  const cooldowns = new CooldownRegistry();
  const jobStore = createJobStore();
  // Orphan scan: reclassify `running` jobs whose pid died during a prior
  // ungraceful exit as `failed`. Fire-and-forget — must not block server start.
  void scanOrphans(jobStore).catch(() => {});

  const server = new McpServer({ name: "agy-bridge", version: "0.4.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, registry, defaultDeps, cooldowns, defaultImageGenDeps, jobStore),
    );
  }
  // Non-runAgy tools — registered OUTSIDE the runAgy loop; none call `agy -p`.
  server.registerTool(
    SESSION_TRANSFER_TOOL.name,
    {
      description: SESSION_TRANSFER_TOOL.description,
      inputSchema: SESSION_TRANSFER_TOOL.schema,
    },
    createSessionTransferHandler(),
  );
  server.registerTool(
    "setup",
    {
      description:
        "Health check for the Antigravity CLI (agy): reports install path, version, and auth " +
        "status (api-key/oauth/missing/unknown). Runs `agy --version` only — makes NO model call.",
      inputSchema: {},
    },
    createSetupHandler(cfg),
  );
  // Background-job lifecycle tools.
  const jobInputSchema = { id: z.string().describe("The job id returned by a background call.") };
  server.registerTool(
    "job_status",
    {
      description:
        "Get the status of a background job (queued/running/done/failed/cancelled) by its job_id. " +
        "Returned immediately by delegate/analyze_files/deep_search/web_lookup when called with " +
        "background:true. Cheap to poll — does NOT run agy. Pass `wait: true` to block until the " +
        "job finishes (or `timeout_ms` elapses). While running, includes `partialOutput` — " +
        "agy's stdout captured so far — as a coarse progress signal.",
      inputSchema: {
        ...jobInputSchema,
        wait: z
          .boolean()
          .optional()
          .describe("If true, block until the job finishes or timeout_ms elapses."),
        timeout_ms: z
          .number()
          .optional()
          .describe("Max ms to wait when wait=true (default 240000)."),
        poll_ms: z
          .number()
          .optional()
          .describe("Poll interval in ms when wait=true (default 1000)."),
      },
    },
    createJobStatusHandler(jobStore),
  );
  server.registerTool(
    "job_result",
    {
      description:
        "Retrieve the output of a finished background job by its job_id. A `running` job returns " +
        "{status:'running'} (poll again later); a `done` job returns the agy output text plus a " +
        "session footer; `failed`/`cancelled` return their reason.",
      inputSchema: jobInputSchema,
    },
    createJobResultHandler(jobStore),
  );
  server.registerTool(
    "job_cancel",
    {
      description:
        "Cancel a running background job by tree-killing its process group (Windows `taskkill " +
        "/T /F`, POSIX negative-pid kill) and mark it cancelled. Idempotent on already-finished " +
        "jobs (returns the current status, no-op).",
      inputSchema: jobInputSchema,
    },
    createJobCancelHandler(jobStore),
  );
  return server;
}
