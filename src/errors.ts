/**
 * Structured classification of agy run failures.
 *
 * agy surfaces failures inconsistently across its channels: a geo-blocked model
 * call returns exit 0 with empty stdout (the rejection lives only in the
 * --log-file), a not-installed binary throws ENOENT, an auth lapse appears in
 * stderr, and a safety refusal comes back as text on stdout. Without
 * classification the host agent sees a confusing "empty output" or raw blob and
 * has no actionable signal.
 *
 * `classifyAgyError` turns the three channels (stdout, stderr, the log file)
 * plus the exit code into a small, stable enum (`kind`) the host can act on:
 *   - geo-blocked   → tell the user to use a VPN to a supported region
 *   - rate-limit    → already handled by quota.ts failover; surfaced for clarity
 *   - auth-required → tell the user to run `agy` once interactively
 *   - safety-refused→ the model refused; rephrase rather than retry
 *   - not-installed → install guidance
 *   - unknown       → fall back to the raw message
 *
 * Pure (regex over strings) so it is fully unit-testable without live agy.
 * Mirrors the classifier pattern from oh-my-agent's `classifyAgyError` and
 * ag-local-bridge's auth-rediscovery, plus the geo-block detector that
 * LEARNINGS.md §4 notes is otherwise only a generic empty-output path.
 */

export type AgyErrorKind =
  | "geo-blocked"
  | "rate-limit"
  | "auth-required"
  | "safety-refused"
  | "not-installed"
  | "unknown";

export interface AgyErrorInput {
  stdout?: string;
  stderr?: string;
  /** Contents of agy's --log-file, when available. */
  log?: string;
  exitCode?: number | null;
  /** Spawn error (NodeJS.ErrnoException), when the binary failed to start. */
  spawnError?: NodeJS.ErrnoException;
}

export interface ClassifiedError {
  kind: AgyErrorKind;
  /** Human-readable, actionable message. */
  message: string;
}

/** Lowercased, CRLF-normalized blob of all channels for matching. */
function haystack(input: AgyErrorInput): string {
  const parts = [input.stdout ?? "", input.stderr ?? "", input.log ?? ""];
  return parts.join("\n").replace(/\r\n/g, "\n").toLowerCase();
}

const PATTERNS: { kind: AgyErrorKind; re: RegExp; message: string }[] = [
  {
    kind: "geo-blocked",
    // Verified live (LEARNINGS.md §4): FAILED_PRECONDITION + "User location is
    // not supported for the API use". agy exits 0 with empty stdout — only the
    // log carries it.
    re: /user location is not supported|failed_precondition.*location/i,
    message:
      "Google's Antigravity backend rejected the request because of the user's location " +
      "(FAILED_PRECONDITION: User location is not supported). This is enforced server-side; " +
      "route through a VPN to a Google-supported region or use a different provider.",
  },
  {
    kind: "rate-limit",
    re: /resource_exhausted \(code 429\)|rate[- ]?limit|quota (exhausted|reached)/,
    message:
      "agy hit a quota/rate limit (RESOURCE_EXHAUSTED 429). Wait for the quota to reset or " +
      "pass an explicit `model` to route around it.",
  },
  {
    kind: "auth-required",
    // Covers: "not authenticated", "unauthenticated", "auth required",
    // "not logged in", "please sign in", "sign-in required",
    // "credentials are expired", "expired credentials", "invalid_grant",
    // and a bare 401.
    re: /(not |un|not[- ]? )?authenticat|auth[ .]?required|not logged in|please (sign|log) in|sign[- ]?in (required|again)|credential[s ]*(are )?(expired|invalid|missing)|invalid_grant|\b401\b/,
    message:
      "agy is not authenticated. Run `agy` once interactively to complete OAuth, or export " +
      "ANTIGRAVITY_API_KEY, then retry.",
  },
  {
    kind: "safety-refused",
    re: /content policy|safety|refus(ed|al)|blocked by safety|prohibited content/i,
    message:
      "agy (or its underlying model) refused the request on safety/content-policy grounds. " +
      "Rephrase the prompt; do not retry verbatim.",
  },
];

/**
 * Classify a failed agy run. ENOENT on the spawn path is detected first
 * (the binary is missing — no point scanning its non-existent output). Order
 * matters: geo-block is checked before rate-limit because a geo-blocked region
 * can also surface quota-adjacent wording; the more specific cause wins.
 */
export function classifyAgyError(input: AgyErrorInput): ClassifiedError {
  if (input.spawnError?.code === "ENOENT") {
    return {
      kind: "not-installed",
      message:
        `agy CLI not found at "${input.spawnError.path ?? "agy"}". Install the ` +
        "Antigravity CLI (https://antigravity.google/docs/cli-getting-started) or set AGY_PATH.",
    };
  }

  const text = haystack(input);

  for (const p of PATTERNS) {
    if (p.re.test(text)) {
      return { kind: p.kind, message: p.message };
    }
  }

  // Non-zero exit with stderr but no recognized pattern — surface the raw
  // stderr so the host isn't left guessing, but tag it unknown so callers can
  // distinguish "structured unknown" from "no classification attempted".
  if (input.exitCode !== 0 && input.exitCode !== null && input.stderr?.trim()) {
    return {
      kind: "unknown",
      message: `agy exited with code ${input.exitCode}: ${input.stderr.trim()}`,
    };
  }

  return {
    kind: "unknown",
    message:
      "agy returned no usable output and no recognized error signature. " +
      "If --log-file is available, inspect it; otherwise retry or report the raw exit.",
  };
}

/**
 * Typed error carrying the classified `kind`. Thrown by runner.ts so the server
 * layer can surface `kind` in the MCP response footer without re-parsing text.
 */
export class AgyRunError extends Error {
  readonly kind: AgyErrorKind;

  constructor(
    classified: ClassifiedError,
    readonly model?: string,
  ) {
    const who = model ? ` [model: ${model}]` : "";
    super(`${classified.message}${who}`);
    this.name = "AgyRunError";
    this.kind = classified.kind;
  }
}
