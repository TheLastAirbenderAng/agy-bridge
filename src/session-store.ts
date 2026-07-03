/**
 * Persisted multi-turn session state.
 *
 * Without this, a server restart loses the {cwd → conversationId} mapping and
 * the `prevOutput` needed for delta extraction, so a follow_up after restart
 * re-sends the whole transcript. This store persists both to a JSON file under
 * ~/.agy-bridge/sessions.json so a restart resumes mid-conversation.
 *
 * Atomic writes (temp + rename) + a serialized promise chain (one RMW at a
 * time) so concurrent calls can't corrupt the file. Mirrors the durability
 * pattern in jobs.ts. Path and fs ops are injectable so it's fully unit-
 * testable with a temp dir.
 *
 * Ported in spirit from raultov/opencode-agy-bridge's session-store.ts.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const SESSIONS_DIR = path.join(homedir(), ".agy-bridge");
export const SESSIONS_FILE = path.join(SESSIONS_DIR, "sessions.json");

export interface SessionEntry {
  conversationId: string;
  /** Last returned output, used by delta.ts to extract only the new turn. */
  prevOutput: string;
  updatedAt: string;
}

export type SessionMap = Record<string, SessionEntry>; // keyed by resolved cwd

export interface SessionStoreDeps {
  storePath: string;
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  rename: (src: string, dest: string) => Promise<void>;
  mkdir: (p: string) => Promise<void>;
}

export const defaultSessionStoreDeps: SessionStoreDeps = {
  storePath: SESSIONS_FILE,
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, data) => writeFile(p, data, "utf8"),
  rename: (src, dest) => rename(src, dest),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
};

export interface SessionStore {
  get(cwd: string): Promise<SessionEntry | undefined>;
  /** Upsert by resolved cwd. Truncates prevOutput to 50k chars to bound growth. */
  set(cwd: string, entry: SessionEntry): Promise<void>;
  /** Remove a session (e.g. when its conversation is exhausted). */
  delete(cwd: string): Promise<void>;
  load(): Promise<SessionMap>;
}

const MAX_PREV_OUTPUT_CHARS = 50_000;

export function createSessionStore(deps: SessionStoreDeps = defaultSessionStoreDeps): SessionStore {
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  const loadRaw = async (): Promise<SessionMap> => {
    let raw: string;
    try {
      raw = await deps.readFile(deps.storePath);
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as SessionMap) : {};
    } catch {
      return {};
    }
  };

  const atomicWrite = async (data: string): Promise<void> => {
    const tmp = `${deps.storePath}.${process.pid}.${Date.now()}.tmp`;
    await deps.writeFile(tmp, data);
    await deps.rename(tmp, deps.storePath);
  };

  const persist = async (map: SessionMap): Promise<void> => {
    await deps.mkdir(path.dirname(deps.storePath));
    await atomicWrite(JSON.stringify(map, null, 2));
  };

  return {
    load: () => serialize(loadRaw),
    get: (cwd) => serialize(async () => (await loadRaw())[path.resolve(cwd)]),
    set: (cwd, entry) =>
      serialize(async () => {
        const map = await loadRaw();
        map[path.resolve(cwd)] = {
          ...entry,
          prevOutput: entry.prevOutput.slice(0, MAX_PREV_OUTPUT_CHARS),
        };
        await persist(map);
      }),
    delete: (cwd) =>
      serialize(async () => {
        const map = await loadRaw();
        delete map[path.resolve(cwd)];
        await persist(map);
      }),
  };
}

export const defaultSessionStore = createSessionStore();
