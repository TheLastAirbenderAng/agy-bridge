<div align="center">

<img src="https://raw.githubusercontent.com/sshahzaiib/agy-bridge/main/assets/banner.svg" alt="agy-bridge — Claude Code delegates heavy tasks to the Antigravity CLI" width="100%">

# agy-bridge

[![CI](https://github.com/sshahzaiib/agy-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/sshahzaiib/agy-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/agy-bridge)](https://www.npmjs.com/package/agy-bridge)
[![npm downloads](https://img.shields.io/npm/dm/agy-bridge)](https://www.npmjs.com/package/agy-bridge)
[![node](https://img.shields.io/node/v/agy-bridge)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/agy-bridge)](LICENSE)

[![Glama score](https://glama.ai/mcp/servers/sshahzaiib/agy-bridge/badges/score.svg)](https://glama.ai/mcp/servers/sshahzaiib/agy-bridge)

An MCP bridge that lets **Claude Code delegate heavy tasks to the Antigravity CLI (`agy`)** — saving Claude's context window and tokens for what matters.

Claude sends a task → the bridge routes it to the best available model via `agy` → only the answer comes back. Large files, deep git searches, and web lookups never touch Claude's context.

**Listed on**

[![Glama](https://img.shields.io/badge/Glama-agy--bridge-7c3aed)](https://glama.ai/mcp/servers/sshahzaiib/agy-bridge)
[![MCP Market](https://img.shields.io/badge/MCP%20Market-agy--bridge-0ea5e9)](https://mcpmarket.com/server/agy-bridge)
[![PulseMCP](https://img.shields.io/badge/PulseMCP-agy--bridge-f43f5e)](https://www.pulsemcp.com/servers/sshahzaiib-agy-bridge)
[![mcp.so](https://img.shields.io/badge/mcp.so-agy--bridge-22c55e)](https://mcp.so/server/agy-bridge/sshahzaiib)
[![MCP Servers](https://img.shields.io/badge/MCP%20Servers-agy--bridge-f59e0b)](https://mcpservers.org/servers/sshahzaiib/agy-bridge)

</div>

```
User → Claude Code → agy-bridge (MCP) → agy CLI → Gemini / Claude / GPT-OSS
                   ←                  ←          ←
```

## Why this over claude-to-agy?

|                 | claude-to-agy               | **agy-bridge**                                                                                                  |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tool surface    | 1 generic `delegate_to_agy` | 9 purpose-built delegation tools + lifecycle tools — agents self-route reliably                                 |
| Model selection | none (agy default only)     | per-tool routing across all `agy models` + short aliases, with availability detection and fallback              |
| Multi-turn      | stateless                   | session continuity — `follow_up` resumes agy conversations without resending context, persisted across restarts |
| Output safety   | unbounded                   | configurable truncation cap protects the host's context                                                         |
| Sandbox         | no                          | optional `--sandbox`, plus per-call `sandbox`/`write` overrides                                                 |
| Install         | uvx (Python)                | npx (Node) — zero install                                                                                       |

## Requirements

- Node.js 18+
- [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`) installed and authenticated
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Install

```bash
# 1. Register the MCP server (user scope = all projects).
#    add-json bakes in a generous client-side timeout so long analyze_files /
#    delegate calls don't trip Claude Code's tool-call deadline (see Timeouts).
claude mcp add-json -s user agy-bridge \
  '{"command":"npx","args":["-y","agy-bridge"],"timeout":600000}'

# 2. Add delegation rules to your project (or ~/.claude/CLAUDE.md for global)
curl -o CLAUDE.md https://raw.githubusercontent.com/sshahzaiib/agy-bridge/main/CLAUDE.md
```

> The `"timeout": 600000` (10 min, milliseconds) is the **client-side** tool-call
> deadline — without it, a cold-start `analyze_files` (~40–50s) or a long
> `delegate` can hit Claude Code's default and return `timed out waiting for
response` while the agy run is still going. If your client doesn't honor a
> per-server `timeout`, set the global env var `MCP_TOOL_TIMEOUT=600000` instead.
> Details and the agy-side budgets are in [Timeouts and cancellation](#timeouts-and-cancellation).

## Tools

| Tool                 | Use for                                                                        | Model routing (first available)                                   |
| -------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `analyze_files`      | Files >200 lines, >3 files at once, logs, dumps, generated code                | Gemini 3.5 Flash (High) → Gemini 3.1 Pro (Low)                    |
| `agy_look`           | Look at EXISTING images (screenshots, diagrams, UI) — for hosts without vision | Gemini 3.5 Flash (High) → Gemini 3.1 Pro (High) → Flash (Medium)  |
| `deep_search`        | git log/diff/blame archaeology, repo-wide greps                                | Gemini 3.5 Flash (Medium) → (High)                                |
| `web_lookup`         | Docs, API references, external/current knowledge                               | Gemini 3.5 Flash (Medium) → (High)                                |
| `adversarial_review` | Plan critiques, design and code reviews; auto-collects git diff                | Gemini 3.1 Pro (High) → Claude Opus 4.6 (Thinking) → Flash (High) |
| `pre_finish_review`  | Adversarial WIP review before declaring a task done                            | Gemini 3.1 Pro (High) → Claude Opus 4.6 (Thinking) → Flash (High) |
| `follow_up`          | Continue a prior session (omit `session_id` to resume latest)                  | inherits the session                                              |
| `image_gen`          | Generate an image via agy's generate_image (Imagen)                            | Gemini 3.5 Flash (High) → (Medium)                                |
| `delegate`           | Anything else heavy (pass `write: true` to let agy edit files)                 | Gemini 3.5 Flash (High)                                           |
| `setup`              | Health check — agy install path, version, auth status                          | n/a (no model call)                                               |
| `session_transfer`   | Resolve a conversation id and return a resume command                          | n/a (reads agy's sessions cache)                                  |
| `job_status`         | Poll a background job (pass `wait: true` to block until done)                  | n/a                                                               |
| `job_result`         | Retrieve a finished background job's output                                    | n/a                                                               |
| `job_cancel`         | Cancel a running background job                                                | n/a                                                               |

All delegating tools accept optional `cwd` (project root), `model` (a canonical name from `agy models` **or a short alias** — see below), and `sandbox` (force `--sandbox` on/off per call). `delegate` additionally accepts `write` (true = agy may edit files).

Every response ends with a footer:

```
---
[agy-bridge] model: Gemini 3.5 Flash (High) | session: 1f0c…-d4 (use follow_up to continue)
```

### Model aliases

Instead of the full canonical string (`"Gemini 3.1 Pro (High)"`), every tool's `model` arg accepts a short alias, resolved case-insensitively:

| Alias                       | Canonical                    |
| --------------------------- | ---------------------------- |
| `flash-low`                 | Gemini 3.5 Flash (Low)       |
| `flash-medium`, `flash-med` | Gemini 3.5 Flash (Medium)    |
| `flash`, `flash-high`       | Gemini 3.5 Flash (High)      |
| `pro-low`                   | Gemini 3.1 Pro (Low)         |
| `pro`, `pro-high`           | Gemini 3.1 Pro (High)        |
| `sonnet`, `claude-sonnet`   | Claude Sonnet 4.6 (Thinking) |
| `opus`, `claude-opus`       | Claude Opus 4.6 (Thinking)   |
| `gpt-oss`, `gpt-oss-120b`   | GPT-OSS 120B (Medium)        |

Canonical strings also pass through unchanged. Unknown aliases throw with the table (typo safety).

### Git-aware review + structured output

`adversarial_review` and `pre_finish_review` accept inline `content`/`files` as before, **or** — when neither is passed — auto-collect the relevant git diff. Pass `scope` (`auto`/`working-tree`/`branch`) and an optional `base` ref. In `auto` mode the bridge reviews the working tree when dirty, else the current branch against the detected default branch (`main`/`master`/`trunk`). Large diffs (over ~256 KB) flip to `self-collect` mode: the bridge tells agy to run its own read-only `git diff` rather than inlining the whole diff into the prompt.

Both review tools instruct agy to END its reply with a fenced JSON block conforming to [`schemas/review-output.schema.json`](schemas/review-output.schema.json) (`verdict`, `summary`, severity-ranked `findings[]`, `next_steps`). The bridge parses it and prepends a one-line verdict + finding-count summary to the footer, so the host gets an actionable headline alongside the full prose.

### Vision delegation (`agy_look`)

For a host agent that **cannot see images** (e.g. a text-only model), `agy_look` delegates image _analysis_ to a vision-capable agy model: pass `image_path` (one or many, PNG/JPEG/WEBP/GIF) and a `question`, and only the answer enters the host's context. Distinct from `image_gen` (which _generates_ images) and `analyze_files` (which reads text/code). Uses agy's `@<path>` file-attachment convention.

### Multi-turn continuity

`follow_up` continues a prior session. Pass `session_id` to continue a specific one, **or omit it to resume the most recent session for the cwd** (the bridge persists `{cwd → conversationId, prevOutput}` to `~/.agy-bridge/sessions.json` across server restarts). On each turn agy replays the whole transcript; the bridge extracts only the new turn via 5-stage delta alignment so the host's context stays small.

### Background jobs + status polling

`delegate`, `analyze_files`, `deep_search`, and `web_lookup` accept `background: true` to return a `{job_id}` immediately and run agy detached. Poll with `job_status` — pass `wait: true` (plus optional `timeout_ms`/`poll_ms`) to block until the job finishes. While a job is running, `job_status` includes `partialOutput` (agy's stdout captured so far) as a coarse progress signal. Cancel with `job_cancel`.

### Structured error classification

Failures are classified into a stable `kind` surfaced in the response footer (`[agy-bridge error kind: geo-blocked]`): **geo-blocked** (Google rejected the request due to user location — use a VPN), **rate-limit**, **auth-required**, **safety-refused**, **not-installed**, or **unknown**. The geo-block in particular no longer surfaces as a confusing empty reply.

### Image format sniffing

agy's `generate_image` returns JPEG bytes regardless of the requested extension. `image_gen` sniffs the actual bytes to set the correct MCP mime type on the image content block, and flags in the footer when the bytes disagree with the path extension.

### Model routing

On first use the bridge runs `agy models` (cached for the process lifetime) and picks the first available model in the tool's preference chain. If none is available it falls back to `AGY_DEFAULT_MODEL`, and finally to agy's own default. agy silently ignores unknown `--model` values, so the bridge validates names up front instead of letting requests land on the wrong model.

### Quota-aware failover

agy never surfaces quota exhaustion in print mode — it silently retries the 429 until its print-timeout, then exits 0 with empty output, which used to look like an indefinite hang. The bridge now watches each run's log file (via `--log-file`) and on `RESOURCE_EXHAUSTED (code 429)`:

1. kills the agy process group immediately (no waiting out the timeout),
2. parses the reset time ("Resets in 4h24m") into an in-process cooldown registry,
3. retries the same prompt on the next model in the tool's chain,
4. skips cooled-down models on all subsequent calls until their quota resets.

Failovers are annotated in the response footer (`failover: <model>: quota exhausted (resets in 4h24m)`). Only when every candidate is exhausted does the call fail — in seconds, with reset times listed — instead of hanging.

### Timeouts and cancellation

Each tool has its own default timeout sized to its job: `web_lookup` 120s, `deep_search` 180s, `analyze_files` / `adversarial_review` / `follow_up` 300s, `delegate` 600s. Setting `AGY_TIMEOUT` explicitly overrides all of them at once. To change a single tool, set `AGY_TIMEOUT_<TOOL_NAME>` instead (e.g. `AGY_TIMEOUT_DEEP_SEARCH=300`); a per-tool override takes precedence over the global `AGY_TIMEOUT` and the tool's default. The full set of per-tool variables is `AGY_TIMEOUT_ANALYZE_FILES`, `AGY_TIMEOUT_DEEP_SEARCH`, `AGY_TIMEOUT_WEB_LOOKUP`, `AGY_TIMEOUT_ADVERSARIAL_REVIEW`, `AGY_TIMEOUT_FOLLOW_UP`, and `AGY_TIMEOUT_DELEGATE`. The kill path escalates SIGTERM → SIGKILL across the whole process group, and the deadline fires even if agy's helper processes hold the output pipes open. Cancelling the tool call from the MCP client (e.g. pressing Esc in Claude Code) also kills the agy run instead of orphaning it.

**Two timeout layers — align them.** The timeouts above are the _agy-side_ budget. Your MCP client (Claude Code) has its own, separate _tool-call_ timeout, and if it is shorter than the agy budget the client gives up first — you'll see `Error: timed out waiting for response` (note: agy-bridge's own timeout reads `agy timed out after Ns` instead). The work is not lost: the agy session persists, so `follow_up` with the returned `session_id` retrieves the result. But the real fix is to make the client wait at least as long as agy: the [Install](#install) command already sets a per-server `timeout` of 600000ms (scoped to the agy-bridge entry only). If you registered the server without it, re-run the `add-json` command from Install, or set the global env var `MCP_TOOL_TIMEOUT=600000`. Rule of thumb: **client `timeout` ≥ agy budget**.

**Expected latency.** Most of the perceived "slowness" is cold start: the first call in a session spawns the agy CLI and warms the model. A simple `analyze_files` over 3 files measures around **40–50s cold** (≈46s observed), dropping on subsequent same-session calls. A first call that also hits a quota 429 takes longer while the bridge fails over. So a client timeout below ~60s will intermittently trip on cold starts even for "simple" questions — size it generously.

## Configuration

All optional, via environment variables:

| Variable               | Default    | Description                                                                                                               |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `AGY_PATH`             | `agy`      | Path to the agy binary                                                                                                    |
| `AGY_TIMEOUT`          | per-tool   | Seconds; overrides all per-tool timeouts at once (see above), passed as `--print-timeout`, enforced with a 15s kill grace |
| `AGY_TIMEOUT_<TOOL>`   | per-tool   | Seconds; overrides the timeout for a single tool only, e.g. `AGY_TIMEOUT_DEEP_SEARCH=300`. Wins over `AGY_TIMEOUT`        |
| `AGY_MAX_OUTPUT_CHARS` | `50000`    | Truncation cap for tool output                                                                                            |
| `AGY_DEFAULT_MODEL`    | unset      | Fallback model when no chain entry is available                                                                           |
| `AGY_SKIP_PERMISSIONS` | `true`     | Pass `--dangerously-skip-permissions` to agy                                                                              |
| `AGY_SANDBOX`          | `false`    | Run agy with `--sandbox`                                                                                                  |
| `AGY_ON_FAILURE`       | `fallback` | `strict` appends an instruction to failed-tool errors telling the calling agent not to absorb the work itself             |

### Failure behavior

The bridge always fails loudly: agy errors surface as MCP tool errors with agy's actual stderr, and degraded model routing is annotated in the response footer. By default the calling agent (Claude) will typically do the work itself after a failure — visible in the transcript, but easy to stop noticing in a long session. Set `AGY_ON_FAILURE=strict` to append an explicit "do NOT perform this work yourself — report the failure to the user" instruction to every delegation error, so you keep control over when token savings are silently lost.

## Development

```bash
npm install
npm test           # vitest unit tests (exec mocked — no agy needed)
npm run typecheck
npm run build      # tsup → dist/index.js
```

## Contributors

Contributions are welcome — open an issue or PR.

<a href="https://github.com/sshahzaiib/agy-bridge/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=sshahzaiib/agy-bridge" alt="Contributors" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=sshahzaiib/agy-bridge&type=Date)](https://www.star-history.com/#sshahzaiib/agy-bridge&Date)

## License

MIT
