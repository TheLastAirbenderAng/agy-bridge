import { describe, it, expect } from "vitest";
import {
  createSessionStore,
  type SessionStoreDeps,
  type SessionMap,
} from "../src/session-store.js";
import path from "node:path";

/**
 * In-memory SessionStoreDeps for hermetic testing. Resolves cwds against /repo
 * so the path.resolve() keys are deterministic on any platform.
 */
function memDeps(initial: SessionMap = {}): SessionStoreDeps & { snapshot: () => SessionMap } {
  let data: SessionMap = { ...initial };
  return {
    storePath: "/fake/sessions.json",
    readFile: async () => JSON.stringify(data),
    writeFile: async (_p, d) => {
      data = JSON.parse(d);
    },
    rename: async (src, _dest) => {
      // atomic write in-memory: writeFile already replaced data
    },
    mkdir: async () => {},
    snapshot: () => data,
  };
}

describe("createSessionStore", () => {
  it("returns undefined for an unknown cwd", async () => {
    const store = createSessionStore(memDeps());
    expect(await store.get("/repo")).toBeUndefined();
  });

  it("persists and retrieves an entry keyed by resolved cwd", async () => {
    const deps = memDeps();
    const store = createSessionStore(deps);
    await store.set("/repo", {
      conversationId: "conv-1",
      prevOutput: "hello",
      updatedAt: "2026-07-03T00:00:00Z",
    });
    const got = await store.get("/repo");
    expect(got?.conversationId).toBe("conv-1");
    expect(got?.prevOutput).toBe("hello");
    // The persisted map is keyed by the resolved cwd.
    expect(deps.snapshot()[path.resolve("/repo")].conversationId).toBe("conv-1");
  });

  it("truncates prevOutput to the 50k cap to bound growth", async () => {
    const store = createSessionStore(memDeps());
    const big = "x".repeat(60_000);
    await store.set("/repo", {
      conversationId: "c",
      prevOutput: big,
      updatedAt: "now",
    });
    expect((await store.get("/repo"))!.prevOutput.length).toBe(50_000);
  });

  it("upserts (overwrites) an existing entry", async () => {
    const store = createSessionStore(memDeps());
    await store.set("/repo", { conversationId: "a", prevOutput: "1", updatedAt: "t1" });
    await store.set("/repo", { conversationId: "b", prevOutput: "2", updatedAt: "t2" });
    expect((await store.get("/repo"))?.conversationId).toBe("b");
  });

  it("deletes an entry", async () => {
    const deps = memDeps({
      [path.resolve("/repo")]: { conversationId: "a", prevOutput: "1", updatedAt: "t" },
    });
    const store = createSessionStore(deps);
    await store.delete("/repo");
    expect(await store.get("/repo")).toBeUndefined();
    expect(deps.snapshot()[path.resolve("/repo")]).toBeUndefined();
  });

  it("load returns the full map", async () => {
    const initial: SessionMap = {
      [path.resolve("/repo")]: { conversationId: "c1", prevOutput: "p1", updatedAt: "t1" },
    };
    const store = createSessionStore(memDeps(initial));
    const map = await store.load();
    expect(map[path.resolve("/repo")].conversationId).toBe("c1");
  });

  it("survives a corrupted store file (returns empty)", async () => {
    const deps: SessionStoreDeps = {
      storePath: "/fake/sessions.json",
      readFile: async () => "not json{",
      writeFile: async () => {},
      rename: async () => {},
      mkdir: async () => {},
    };
    const store = createSessionStore(deps);
    expect(await store.load()).toEqual({});
    expect(await store.get("/repo")).toBeUndefined();
  });
});
