/**
 * Git-aware review context collection.
 *
 * Without this, `adversarial_review`/`pre_finish_review` only review what the
 * caller passes inline. codex-plugin-cc's insight (lib/git.mjs) is that a
 * review tool should auto-collect the relevant git diff when nothing is passed:
 * the working-tree diff when the tree is dirty, otherwise the current branch's
 * diff against the default branch. This makes "review my work" a one-shot call.
 *
 * Ports a focused subset of codex's git.mjs: ensureGitRepository, getRepoRoot,
 * resolveReviewTarget, getWorkingTreeState, detectDefaultBranch, and
 * collectReviewContext (working-tree + branch modes, inline diff with a size
 * guard so a 50 MB diff doesn't blow the prompt). The byte-budget / multi-file
 * measurement logic is simplified to a single threshold check — enough for an
 * MCP tool whose output is already truncated by runner.ts's maxOutputChars.
 *
 * All git invocations go through an injectable GitExec (defaults to
 * execWithClosedStdin) so every path is unit-testable without a real repo.
 */
import path from "node:path";
import type { ExecFn } from "./runner.js";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  /** 0 on success; non-zero on failure. */
  status: number;
  /** Set when the binary could not be spawned (ENOENT). */
  error?: NodeJS.ErrnoException;
}

export type GitExec = (
  args: string[],
  options: { cwd: string; maxBuffer?: number },
) => Promise<GitExecResult>;

/**
 * Wraps an ExecFn (execFile-style) into the GitExec shape. Uses
 * execWithClosedStdin by default so a git that unexpectedly reads stdin cannot
 * hang. Caught errors are normalized into {status, error} so callers can branch
 * on `git not installed` vs `not a repo` without try/catch noise.
 */
export const defaultGitExec =
  (exec: ExecFn): GitExec =>
  async (args, options) => {
    try {
      const r = await exec("git", args, {
        cwd: options.cwd,
        timeout: 15_000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
      });
      return { stdout: r.stdout, stderr: r.stderr, status: 0 };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      // execFile rejects with the error object carrying stdout/stderr for
      // non-zero exits. Treat anything with a numeric code as a git failure we
      // can report; ENOENT means git itself is missing.
      if (err.code === "ENOENT") {
        return { stdout: "", stderr: "", status: -1, error: err };
      }
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        status: typeof err.code === "number" ? err.code : 1,
      };
    }
  };

export type ReviewScope = "auto" | "working-tree" | "branch";

export interface ReviewTarget {
  mode: "working-tree" | "branch";
  label: string;
  baseRef?: string;
  explicit: boolean;
}

export interface WorkingTreeState {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  isDirty: boolean;
}

export interface ReviewContext {
  /** Repository root (git toplevel). */
  repoRoot: string;
  branch: string;
  target: ReviewTarget;
  /** Number of changed files in scope. */
  fileCount: number;
  /** Approximate diff size in bytes (for the include/exclude-diff gate). */
  diffBytes: number;
  /** True when the diff is inlined into the prompt; false → agy self-collects. */
  inputMode: "inline-diff" | "self-collect";
  /** One-line human summary, e.g. "Reviewing 3 staged, 1 unstaged file(s)." */
  summary: string;
  /** The assembled prompt body (status + diffs + untracked). */
  content: string;
}

const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function lines(s: string): string[] {
  return s
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function uniqueSorted(...groups: string[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  return [`## ${title}`, "", trimmed ? trimmed : "(none)", ""].join("\n");
}

export async function ensureGitRepository(cwd: string, git: GitExec): Promise<string> {
  const r = await git(["rev-parse", "--show-toplevel"], { cwd });
  if (r.error?.code === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (r.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return r.stdout.trim();
}

export async function getCurrentBranch(cwd: string, git: GitExec): Promise<string> {
  const r = await git(["branch", "--show-current"], { cwd });
  return r.stdout.trim() || "HEAD";
}

export async function getWorkingTreeState(cwd: string, git: GitExec): Promise<WorkingTreeState> {
  const [staged, unstaged, untracked] = await Promise.all([
    git(["diff", "--cached", "--name-only"], { cwd }),
    git(["diff", "--name-only"], { cwd }),
    git(["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);
  const s = lines(staged.stdout);
  const u = lines(unstaged.stdout);
  const t = lines(untracked.stdout);
  return { staged: s, unstaged: u, untracked: t, isDirty: s.length + u.length + t.length > 0 };
}

/**
 * Detect the repository's default branch. Tries origin/HEAD first, then falls
 * back to main/master/trunk (local then remote). Throws if none is found — the
 * caller should pass an explicit --base or use working-tree scope.
 */
export async function detectDefaultBranch(cwd: string, git: GitExec): Promise<string> {
  const symbolic = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd });
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }
  for (const candidate of ["main", "master", "trunk"]) {
    const local = await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], {
      cwd,
    });
    if (local.status === 0) return candidate;
    const remote = await git(
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
      { cwd },
    );
    if (remote.status === 0) return `origin/${candidate}`;
  }
  throw new Error(
    "Unable to detect the repository default branch. Pass an explicit `base` or use scope 'working-tree'.",
  );
}

/**
 * Decide what to review. Precedence (mirrors codex resolveReviewTarget):
 *   explicit base  →  branch mode against base
 *   scope=working-tree  →  working-tree mode
 *   scope=branch        →  branch mode against the detected default branch
 *   scope=auto          →  working-tree if dirty, else branch vs default
 */
export async function resolveReviewTarget(
  cwd: string,
  git: GitExec,
  opts: { scope?: ReviewScope; base?: string } = {},
): Promise<ReviewTarget> {
  const scope = opts.scope ?? "auto";
  if (opts.base) {
    return {
      mode: "branch",
      label: `branch diff against ${opts.base}`,
      baseRef: opts.base,
      explicit: true,
    };
  }
  if (scope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff", explicit: true };
  }
  if (!["auto", "branch"].includes(scope)) {
    throw new Error(
      `Unsupported review scope "${scope}". Use one of: auto, working-tree, branch, or pass a base ref.`,
    );
  }
  if (scope === "branch") {
    const base = await detectDefaultBranch(cwd, git);
    return { mode: "branch", label: `branch diff against ${base}`, baseRef: base, explicit: true };
  }
  // auto: prefer the working tree when there are uncommitted changes, else the branch.
  const state = await getWorkingTreeState(cwd, git);
  if (state.isDirty) {
    return { mode: "working-tree", label: "working tree diff", explicit: false };
  }
  const base = await detectDefaultBranch(cwd, git);
  return { mode: "branch", label: `branch diff against ${base}`, baseRef: base, explicit: false };
}

async function diffBytesFor(cwd: string, git: GitExec, argSets: string[][]): Promise<number> {
  let total = 0;
  for (const args of argSets) {
    const r = await git(args, { cwd, maxBuffer: 1 });
    // maxBuffer=1 forces ENOBUFS immediately for any non-empty diff, giving a
    // cheap "is this bigger than our budget?" probe without reading it all.
    if (r.error && (r.error as NodeJS.ErrnoException).code !== "ENOBUFS") {
      // git itself failed — count as oversized so we fall back to self-collect.
      return Number.MAX_SAFE_INTEGER;
    }
    total += Buffer.byteLength(r.stdout, "utf8");
  }
  return total;
}

/**
 * Collect the full review context: the diff(s), git status, and untracked-file
 * bodies, assembled into one prompt-ready `content` string. When the diff is
 * large (> maxInlineDiffBytes), `inputMode` flips to 'self-collect' and the
 * content degrades to a stat-only summary — agy is then told to run its own
 * read-only git commands rather than rely on the inlined diff.
 */
export async function collectReviewContext(
  cwd: string,
  git: GitExec,
  opts: { scope?: ReviewScope; base?: string; maxInlineDiffBytes?: number } = {},
): Promise<ReviewContext> {
  const repoRoot = await ensureGitRepository(cwd, git);
  const branch = await getCurrentBranch(repoRoot, git);
  const target = await resolveReviewTarget(repoRoot, git, opts);
  const maxBytes = opts.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;

  if (target.mode === "working-tree") {
    const state = await getWorkingTreeState(repoRoot, git);
    const bytes = await diffBytesFor(repoRoot, git, [
      ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff"],
    ]);
    const includeDiff = bytes <= maxBytes;
    const changedFiles = uniqueSorted(state.staged, state.unstaged, state.untracked);

    const status = (await git(["status", "--short", "--untracked-files=all"], { cwd: repoRoot }))
      .stdout;
    let content: string;
    if (includeDiff) {
      const stagedDiff = (
        await git(["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"], {
          cwd: repoRoot,
        })
      ).stdout;
      const unstagedDiff = (
        await git(["diff", "--binary", "--no-ext-diff", "--submodule=diff"], { cwd: repoRoot })
      ).stdout;
      content = [
        section("Git Status", status),
        section("Staged Diff", stagedDiff),
        section("Unstaged Diff", unstagedDiff),
        section("Untracked Files", state.untracked.map((f) => `### ${f}`).join("\n") || "(none)"),
      ].join("\n");
    } else {
      content = [
        section("Git Status", status),
        section(
          "Changed Files",
          changedFiles.join("\n") + `\n\n(diff omitted: ${bytes} bytes exceeds ${maxBytes} budget)`,
        ),
      ].join("\n");
    }

    return {
      repoRoot,
      branch,
      target,
      fileCount: changedFiles.length,
      diffBytes: bytes === Number.MAX_SAFE_INTEGER ? maxBytes + 1 : bytes,
      inputMode: includeDiff ? "inline-diff" : "self-collect",
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      content,
    };
  }

  // branch mode
  const baseRef = target.baseRef!;
  const mergeBaseR = await git(["merge-base", "HEAD", baseRef], { cwd: repoRoot });
  if (mergeBaseR.status !== 0) {
    throw new Error(
      `Could not find a merge-base between HEAD and ${baseRef}. Ensure the base ref exists locally.`,
    );
  }
  const mergeBase = mergeBaseR.stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const changedFiles = lines(
    (await git(["diff", "--name-only", commitRange], { cwd: repoRoot })).stdout,
  );
  const bytes = await diffBytesFor(repoRoot, git, [
    ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange],
  ]);
  const includeDiff = bytes <= maxBytes;
  const logOutput = (await git(["log", "--oneline", "--decorate", commitRange], { cwd: repoRoot }))
    .stdout;
  const diffStat = (await git(["diff", "--stat", commitRange], { cwd: repoRoot })).stdout;

  let content: string;
  if (includeDiff) {
    const diff = (
      await git(["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange], {
        cwd: repoRoot,
      })
    ).stdout;
    content = [
      section("Commit Log", logOutput),
      section("Diff Stat", diffStat),
      section("Branch Diff", diff),
    ].join("\n");
  } else {
    content = [
      section("Commit Log", logOutput),
      section("Diff Stat", diffStat),
      section(
        "Changed Files",
        changedFiles.join("\n") + `\n\n(diff omitted: ${bytes} bytes exceeds ${maxBytes} budget)`,
      ),
    ].join("\n");
  }

  return {
    repoRoot,
    branch,
    target,
    fileCount: changedFiles.length,
    diffBytes: bytes === Number.MAX_SAFE_INTEGER ? maxBytes + 1 : bytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    summary: `Reviewing branch ${branch} against ${baseRef} from merge-base ${mergeBase}.`,
    content,
  };
}

/**
 * Resolve a relative file path against the repo root. Exported so review
 * prompts can present absolute paths to agy consistently.
 */
export function resolveInRepo(repoRoot: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
}
