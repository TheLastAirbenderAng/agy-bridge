export function parseModels(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim().replace(/\s*\(current\)$/, ""))
    .filter((l) => l.length > 0);
}

/**
 * Canonical model names accepted verbatim (case-sensitive — these are the exact
 * strings agy's own TUI writes, so a caller can pass them through unchanged).
 */
export const CANONICAL_MODELS = [
  "Gemini 3.5 Flash (Low)",
  "Gemini 3.5 Flash (Medium)",
  "Gemini 3.5 Flash (High)",
  "Gemini 3.1 Pro (Low)",
  "Gemini 3.1 Pro (High)",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
  "GPT-OSS 120B (Medium)",
] as const;

/**
 * Case-insensitive alias → canonical model map. Mirrors the table in
 * references/antigravity-plugin-cc/.../agy-run.sh `resolve_model_alias` so a
 * caller can write `model: "flash"` instead of the full canonical string.
 * Canonical strings also pass through. Unknown aliases throw with the table —
 * typo safety beats silent forward-compat (matches agy-run.sh exit 64).
 */
const ALIASES: Record<string, string> = {
  "flash-low": "Gemini 3.5 Flash (Low)",
  "flash-medium": "Gemini 3.5 Flash (Medium)",
  "flash-med": "Gemini 3.5 Flash (Medium)",
  flash: "Gemini 3.5 Flash (High)",
  "flash-high": "Gemini 3.5 Flash (High)",
  "pro-low": "Gemini 3.1 Pro (Low)",
  pro: "Gemini 3.1 Pro (High)",
  "pro-high": "Gemini 3.1 Pro (High)",
  sonnet: "Claude Sonnet 4.6 (Thinking)",
  "claude-sonnet": "Claude Sonnet 4.6 (Thinking)",
  opus: "Claude Opus 4.6 (Thinking)",
  "claude-opus": "Claude Opus 4.6 (Thinking)",
  "gpt-oss": "GPT-OSS 120B (Medium)",
  "gpt-oss-120b": "GPT-OSS 120B (Medium)",
};

export class UnknownModelAliasError extends Error {
  constructor(input: string) {
    super(`Unknown model alias "${input}". Valid aliases: ${Object.keys(ALIASES).join(", ")}.`);
    this.name = "UnknownModelAliasError";
  }
}

/**
 * Resolve a user-supplied model string to its canonical form. Passes canonical
 * strings through unchanged; resolves aliases case-insensitively; throws
 * `UnknownModelAliasError` on anything unrecognized. Empty/undefined input
 * returns undefined ("let agy pick"). Pure — fully unit-testable.
 */
export function resolveModelAlias(input: string | undefined | null): string | undefined {
  if (input == null || input.trim() === "") return undefined;
  const trimmed = input.trim();
  if ((CANONICAL_MODELS as readonly string[]).includes(trimmed)) return trimmed;
  const lc = trimmed.toLowerCase();
  if (ALIASES[lc]) return ALIASES[lc];
  throw new UnknownModelAliasError(trimmed);
}

export interface ResolveOptions {
  explicit?: string;
  chain: string[];
  defaultModel?: string;
}

export interface Resolution {
  model?: string;
  note?: string;
}

export interface ChainResolution {
  models: (string | undefined)[];
  note?: string;
}

export class ModelRegistry {
  private listing: string[] | null = null;
  private pending: Promise<string[] | null> | null = null;

  constructor(private fetchListing: () => Promise<string>) {}

  async available(): Promise<string[] | null> {
    if (this.listing) return this.listing;
    // Cache the promise so concurrent first calls share one fetch.
    this.pending ??= this.fetchListing()
      .then(parseModels)
      .catch(() => null);
    const result = await this.pending;
    if (result) this.listing = result;
    else this.pending = null; // transient failure — retry on the next call
    return result;
  }

  async resolve(opts: ResolveOptions): Promise<Resolution> {
    const r = await this.resolveChain(opts);
    return { model: r.models[0], note: r.note };
  }

  /**
   * Returns every viable model in preference order so callers can fail over
   * (e.g. on quota exhaustion). `[undefined]` means "let agy pick".
   */
  async resolveChain(opts: ResolveOptions): Promise<ChainResolution> {
    const available = await this.available();

    if (opts.explicit) {
      if (available === null) {
        return {
          models: [opts.explicit],
          note: "could not list agy models; passing model through unvalidated",
        };
      }
      if (available.includes(opts.explicit)) return { models: [opts.explicit] };
      throw new Error(
        `Model "${opts.explicit}" is not available. Available models:\n${available.join("\n")}`,
      );
    }

    if (available === null) {
      return {
        models: [undefined],
        note: "could not list agy models; using agy's own default model",
      };
    }
    const models = opts.chain.filter((m) => available.includes(m));
    if (
      opts.defaultModel &&
      available.includes(opts.defaultModel) &&
      !models.includes(opts.defaultModel)
    ) {
      models.push(opts.defaultModel);
    }
    if (models.length === 0) {
      return {
        models: [undefined],
        note: "no preferred model available; using agy's own default model",
      };
    }
    return { models };
  }
}
