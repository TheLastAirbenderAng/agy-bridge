import { describe, it, expect } from "vitest";
import {
  snapshotConversations,
  diffSnapshots,
  discoverConversationId,
  type ListDir,
} from "../src/conversation-tracker.js";

describe("snapshotConversations", () => {
  it("returns the set of .pb stems in the dir", async () => {
    const listDir: ListDir = async () => ["aaa.pb", "bbb.pb", "ignore.txt", "ccc.pb"];
    const snap = await snapshotConversations(listDir, "/fake");
    expect(snap).toEqual(new Set(["aaa", "bbb", "ccc"]));
  });
  it("returns an empty set when the dir is missing", async () => {
    const listDir: ListDir = async () => {
      throw new Error("ENOENT");
    };
    const snap = await snapshotConversations(listDir, "/fake");
    expect(snap).toEqual(new Set());
  });
  it("ignores non-.pb files", async () => {
    const listDir: ListDir = async () => ["keep.pb", "drop.json", "also-drop"];
    expect(await snapshotConversations(listDir, "/fake")).toEqual(new Set(["keep"]));
  });
});

describe("diffSnapshots", () => {
  it("returns the single new id", () => {
    const before = new Set(["a", "b"]);
    const after = new Set(["a", "b", "c"]);
    expect(diffSnapshots(before, after)).toEqual({ conversationId: "c" });
  });
  it("returns null + no-new when nothing was added", () => {
    expect(diffSnapshots(new Set(["a"]), new Set(["a"]))).toEqual({
      conversationId: null,
      reason: "no-new",
    });
  });
  it("returns null + ambiguous when more than one was added", () => {
    const before = new Set(["a"]);
    const after = new Set(["a", "b", "c"]);
    expect(diffSnapshots(before, after)).toEqual({ conversationId: null, reason: "ambiguous" });
  });
  it("ignores removals (only new ids count)", () => {
    expect(diffSnapshots(new Set(["a", "gone"]), new Set(["a", "new"]))).toEqual({
      conversationId: "new",
    });
  });
});

describe("discoverConversationId", () => {
  it("snapshots, runs the op, then diffs", async () => {
    let entries = ["old.pb"];
    const listDir: ListDir = async () => entries;
    const op = async () => {
      entries = ["old.pb", "fresh.pb"]; // simulate agy writing a new .pb
    };
    const result = await discoverConversationId(op, listDir, "/fake");
    expect(result.conversationId).toBe("fresh");
  });
  it("returns no-new when the op added nothing", async () => {
    const entries = ["only.pb"];
    const listDir: ListDir = async () => entries;
    const result = await discoverConversationId(async () => {}, listDir, "/fake");
    expect(result).toEqual({ conversationId: null, reason: "no-new" });
  });
});
