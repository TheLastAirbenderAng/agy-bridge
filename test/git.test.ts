import { describe, it, expect } from "vitest";
import {
  ensureGitRepository,
  getCurrentBranch,
  getWorkingTreeState,
  detectDefaultBranch,
  resolveReviewTarget,
  collectReviewContext,
  defaultGitExec,
  type GitExec,
  type GitExecResult,
} from "../src/git.js";

/**
 * Build a mock GitExec that returns canned results keyed by a normalized
 * version of the arg list. Keeps tests hermetic — no real repo needed.
 */
function mockGit(table: Record<string, GitExecResult | (() => GitExecResult)>): {
  git: GitExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitExec = async (args, _options) => {
    calls.push(args);
    const key = args.join(" ");
    // Try exact match, then a "starts with first flag" fallback so e.g. all
    // `diff --name-only ...` variants resolve to one canned entry.
    let entry: GitExecResult | (() => GitExecResult) | undefined = table[key];
    if (entry === undefined) {
      const startKey = Object.keys(table).find((k) => key.startsWith(k.split(" {")[0] + " "));
      entry = startKey ? table[startKey] : undefined;
    }
    if (entry === undefined) {
      return { stdout: "", stderr: "", status: 0 };
    }
    return typeof entry === "function" ? entry() : entry;
  };
  return { git, calls };
}

const OK = (stdout = ""): GitExecResult => ({ stdout, stderr: "", status: 0 });
const FAIL = (stderr = "fail"): GitExecResult => ({ stdout: "", stderr, status: 1 });

describe("ensureGitRepository", () => {
  it("returns the repo toplevel on success", async () => {
    const { git } = mockGit({ "rev-parse --show-toplevel": OK("/repo") });
    await expect(ensureGitRepository("/repo", git)).resolves.toBe("/repo");
  });
  it("throws 'not a Git repository' on non-zero exit", async () => {
    const { git } = mockGit({ "rev-parse --show-toplevel": FAIL() });
    await expect(ensureGitRepository("/repo", git)).rejects.toThrow(/Git repository/i);
  });
  it("throws a clear 'git not installed' on ENOENT", async () => {
    const e = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    const git: GitExec = async () => ({ stdout: "", stderr: "", status: -1, error: e });
    await expect(ensureGitRepository("/repo", git)).rejects.toThrow(/git is not installed/i);
  });
});

describe("getWorkingTreeState", () => {
  it("parses staged / unstaged / untracked file lists", async () => {
    const { git } = mockGit({
      "diff --cached --name-only": OK("a.ts\nb.ts"),
      "diff --name-only": OK("b.ts"),
      "ls-files --others --exclude-standard": OK("new.ts"),
    });
    const s = await getWorkingTreeState("/repo", git);
    expect(s.staged).toEqual(["a.ts", "b.ts"]);
    expect(s.unstaged).toEqual(["b.ts"]);
    expect(s.untracked).toEqual(["new.ts"]);
    expect(s.isDirty).toBe(true);
  });
  it("reports isDirty=false when everything is clean", async () => {
    const { git } = mockGit({
      "diff --cached --name-only": OK(""),
      "diff --name-only": OK(""),
      "ls-files --others --exclude-standard": OK(""),
    });
    const s = await getWorkingTreeState("/repo", git);
    expect(s.isDirty).toBe(false);
  });
});

describe("detectDefaultBranch", () => {
  it("uses origin/HEAD when set", async () => {
    const { git } = mockGit({
      "symbolic-ref --quiet refs/remotes/origin/HEAD": OK("refs/remotes/origin/main"),
    });
    await expect(detectDefaultBranch("/repo", git)).resolves.toBe("main");
  });
  it("falls back to local main when origin/HEAD unset", async () => {
    const { git } = mockGit({
      "symbolic-ref --quiet refs/remotes/origin/HEAD": { stdout: "", stderr: "", status: 1 },
      "show-ref --verify --quiet refs/heads/main": OK(),
    });
    await expect(detectDefaultBranch("/repo", git)).resolves.toBe("main");
  });
  it("throws when nothing is found", async () => {
    const alwaysFail: GitExec = async () => ({ stdout: "", stderr: "", status: 1 });
    await expect(detectDefaultBranch("/repo", alwaysFail)).rejects.toThrow(/default branch/i);
  });
});

describe("resolveReviewTarget", () => {
  it("honors an explicit base ref", async () => {
    const { git } = mockGit({});
    const t = await resolveReviewTarget("/repo", git, { base: "origin/dev" });
    expect(t.mode).toBe("branch");
    expect(t.baseRef).toBe("origin/dev");
    expect(t.explicit).toBe(true);
  });
  it("scope=working-tree forces working-tree mode", async () => {
    const { git } = mockGit({});
    const t = await resolveReviewTarget("/repo", git, { scope: "working-tree" });
    expect(t.mode).toBe("working-tree");
  });
  it("scope=auto picks working-tree when dirty", async () => {
    const { git } = mockGit({
      "diff --cached --name-only": OK("a.ts"),
      "diff --name-only": OK(""),
      "ls-files --others --exclude-standard": OK(""),
    });
    const t = await resolveReviewTarget("/repo", git, { scope: "auto" });
    expect(t.mode).toBe("working-tree");
    expect(t.explicit).toBe(false);
  });
  it("scope=auto falls back to branch vs default when clean", async () => {
    const { git } = mockGit({
      "diff --cached --name-only": OK(""),
      "diff --name-only": OK(""),
      "ls-files --others --exclude-standard": OK(""),
      "symbolic-ref --quiet refs/remotes/origin/HEAD": OK("refs/remotes/origin/main"),
    });
    const t = await resolveReviewTarget("/repo", git, { scope: "auto" });
    expect(t.mode).toBe("branch");
    expect(t.baseRef).toBe("main");
  });
  it("rejects an unsupported scope", async () => {
    const { git } = mockGit({});
    await expect(resolveReviewTarget("/repo", git, { scope: "bogus" as never })).rejects.toThrow(
      /Unsupported review scope/,
    );
  });
});

describe("collectReviewContext", () => {
  it("collects a working-tree review with inlined staged+unstaged diffs", async () => {
    const { git } = mockGit({
      "rev-parse --show-toplevel": OK("/repo"),
      "branch --show-current": OK("feature"),
      "diff --cached --name-only": OK("a.ts"),
      "diff --name-only": OK(""),
      "ls-files --others --exclude-standard": OK(""),
      "status --short --untracked-files=all": OK("M  a.ts"),
      "diff --cached --binary --no-ext-diff --submodule=diff": OK("STAGED DIFF BODY"),
      "diff --binary --no-ext-diff --submodule=diff": OK(""),
    });
    const ctx = await collectReviewContext("/repo", git, { scope: "working-tree" });
    expect(ctx.repoRoot).toBe("/repo");
    expect(ctx.branch).toBe("feature");
    expect(ctx.target.mode).toBe("working-tree");
    expect(ctx.fileCount).toBe(1);
    expect(ctx.inputMode).toBe("inline-diff");
    expect(ctx.content).toContain("STAGED DIFF BODY");
    expect(ctx.content).toContain("Git Status");
    expect(ctx.summary).toMatch(/1 staged/);
  });

  it("flips to self-collect when the diff exceeds the byte budget", async () => {
    const big = "x".repeat(1024);
    const { git } = mockGit({
      "rev-parse --show-toplevel": OK("/repo"),
      "branch --show-current": OK("feature"),
      "diff --cached --name-only": OK("a.ts"),
      "diff --name-only": OK(""),
      "ls-files --others --exclude-standard": OK(""),
      "status --short --untracked-files=all": OK("M  a.ts"),
      "diff --cached --binary --no-ext-diff --submodule=diff": OK(big),
      "diff --binary --no-ext-diff --submodule=diff": OK(""),
    });
    const ctx = await collectReviewContext("/repo", git, {
      scope: "working-tree",
      maxInlineDiffBytes: 100,
    });
    expect(ctx.inputMode).toBe("self-collect");
    expect(ctx.content).toContain("diff omitted");
  });

  it("collects a branch review against the merge-base", async () => {
    const { git } = mockGit({
      "rev-parse --show-toplevel": OK("/repo"),
      "branch --show-current": OK("feature"),
      "symbolic-ref --quiet refs/remotes/origin/HEAD": OK("refs/remotes/origin/main"),
      "diff --cached --name-only": OK(""),
      "diff --name-only": OK(""),
      "ls-files --others --exclude-standard": OK(""),
      "merge-base HEAD main": OK("abc123"),
      "diff --name-only abc123..HEAD": OK("a.ts\nb.ts"),
      "diff --binary --no-ext-diff --submodule=diff abc123..HEAD": OK("BRANCH DIFF BODY"),
      "log --oneline --decorate abc123..HEAD": OK("abc1234 feat: x"),
      "diff --stat abc123..HEAD": OK(" a.ts | 2 +-\n b.ts | 4 ++--"),
    });
    const ctx = await collectReviewContext("/repo", git, { scope: "branch" });
    expect(ctx.target.mode).toBe("branch");
    expect(ctx.target.baseRef).toBe("main");
    expect(ctx.fileCount).toBe(2);
    expect(ctx.content).toContain("BRANCH DIFF BODY");
    expect(ctx.content).toContain("Commit Log");
    expect(ctx.summary).toMatch(/against main/);
  });

  it("throws on merge-base failure in branch mode", async () => {
    const { git } = mockGit({
      "rev-parse --show-toplevel": OK("/repo"),
      "branch --show-current": OK("feature"),
      "symbolic-ref --quiet refs/remotes/origin/HEAD": OK("refs/remotes/origin/main"),
      "diff --cached --name-only": OK(""),
      "diff --name-only": OK(""),
      "ls-files --others --exclude-standard": OK(""),
      "merge-base HEAD main": FAIL("no merge base"),
    });
    await expect(collectReviewContext("/repo", git, { scope: "branch" })).rejects.toThrow(
      /merge-base/,
    );
  });
});

describe("defaultGitExec", () => {
  it("normalizes a non-zero git exit into {status, stdout, stderr}", async () => {
    const exec = async () => {
      const e = Object.assign(new Error("Command failed: git status"), {
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      });
      throw e;
    };
    const git = defaultGitExec(exec as never);
    const r = await git(["status"], { cwd: "/repo" });
    expect(r.status).toBe(128);
    expect(r.stderr).toContain("not a git repository");
  });
});
