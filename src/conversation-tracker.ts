/**
 * Conversation-id discovery by diffing agy's conversations directory.
 *
 * agy does NOT print its conversation id to stdout. On the first turn of a new
 * conversation it writes a `~/.gemini/antigravity-cli/conversations/<id>.pb`
 * file. By snapshotting the directory before and after an `agy -p` run, the
 * single newly-created `.pb` stem IS the conversation id — pass it back via
 * `--conversation <id>` on subsequent turns for true multi-turn continuity.
 *
 * Ported from raultov/opencode-agy-bridge's conversation-tracker.ts. Refuses
 * to bind when more than one new `.pb` appears (ambiguous — fall back to
 * single-turn rather than guessing).
 *
 * Pure over an injectable dir-lister: every function takes a `listDir` param
 * defaulting to the real fs read, so the diff logic is fully unit-testable
 * with a fake listing.
 */
import { homedir } from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";

export const CONVERSATIONS_DIR = path.join(
  homedir(),
  ".gemini",
  "antigravity-cli",
  "conversations",
);

export type ListDir = (dir: string) => Promise<string[]>;

export const defaultListDir: ListDir = (dir) => readdir(dir);

/** Snapshot the set of `.pb` stems currently in the conversations dir. */
export async function snapshotConversations(
  listDir: ListDir = defaultListDir,
  dir: string = CONVERSATIONS_DIR,
): Promise<Set<string>> {
  let entries: string[];
  try {
    entries = await listDir(dir);
  } catch {
    return new Set(); // missing dir = no conversations yet
  }
  return new Set(entries.filter((e) => e.endsWith(".pb")).map((e) => e.replace(/\.pb$/, "")));
}

export interface DiscoveryResult {
  /** The newly-discovered conversation id, or null when ambiguous/none. */
  conversationId: string | null;
  /** Why binding was skipped, when it was. */
  reason?: "none" | "ambiguous" | "no-new";
}

/**
 * Diff a before/after snapshot and return the single new conversation id, or
 * null with a reason when zero or more than one new `.pb` appeared. Deterministic.
 */
export function diffSnapshots(before: Set<string>, after: Set<string>): DiscoveryResult {
  const newIds = [...after].filter((id) => !before.has(id));
  if (newIds.length === 0) return { conversationId: null, reason: "no-new" };
  if (newIds.length > 1) return { conversationId: null, reason: "ambiguous" };
  return { conversationId: newIds[0] };
}

/**
 * One-shot helper: snapshot before, run an async op, snapshot after, diff.
 * Returns the discovered conversation id (or null + reason). The op is the
 * agy run itself; wrapping it here keeps the snapshot bookkeeping localized.
 */
export async function discoverConversationId(
  op: () => Promise<void>,
  listDir: ListDir = defaultListDir,
  dir: string = CONVERSATIONS_DIR,
): Promise<DiscoveryResult> {
  const before = await snapshotConversations(listDir, dir);
  await op();
  const after = await snapshotConversations(listDir, dir);
  return diffSnapshots(before, after);
}
