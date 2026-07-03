import { describe, it, expect } from "vitest";
import { classifyAgyError, AgyRunError } from "../src/errors.js";

const GEO_LOG =
  "E0703 log.go: agent executor error: FAILED_PRECONDITION (code 400): " +
  "User location is not supported for the API use.";

const QUOTA_LOG =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";

describe("classifyAgyError", () => {
  it("classifies ENOENT spawn errors as not-installed", () => {
    const e = new Error("spawn agy ENOENT") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    e.path = "/usr/local/bin/agy";
    const c = classifyAgyError({ spawnError: e });
    expect(c.kind).toBe("not-installed");
    expect(c.message).toMatch(/not found/i);
    expect(c.message).toContain("/usr/local/bin/agy");
  });

  it("classifies a geo-block log as geo-blocked (the key LEARNINGS.md §4 case)", () => {
    const c = classifyAgyError({ stdout: "", log: GEO_LOG, exitCode: 0 });
    expect(c.kind).toBe("geo-blocked");
    expect(c.message).toMatch(/location is not supported/i);
    expect(c.message).toMatch(/vpn/i);
  });

  it("classifies a 429 quota log as rate-limit", () => {
    const c = classifyAgyError({ stdout: "", log: QUOTA_LOG, exitCode: 0 });
    expect(c.kind).toBe("rate-limit");
    expect(c.message).toMatch(/quota|rate/i);
  });

  it("classifies auth-expired stderr as auth-required", () => {
    const c = classifyAgyError({
      stderr: "Error: credentials are expired. Please sign in again.",
      exitCode: 1,
    });
    expect(c.kind).toBe("auth-required");
  });

  it("classifies a safety refusal on stdout as safety-refused", () => {
    const c = classifyAgyError({
      stdout: "I'm unable to help with that request as it violates content policy.",
      exitCode: 0,
    });
    expect(c.kind).toBe("safety-refused");
  });

  it("prefers geo-block over rate-limit when both wording could match", () => {
    // geo-block is checked first in PATTERNS order
    const c = classifyAgyError({
      log: "FAILED_PRECONDITION: User location is not supported. RESOURCE_EXHAUSTED (code 429).",
      exitCode: 0,
    });
    expect(c.kind).toBe("geo-blocked");
  });

  it("falls back to unknown-with-stderr for unrecognized non-zero exits", () => {
    const c = classifyAgyError({ stderr: "some novel error", exitCode: 2 });
    expect(c.kind).toBe("unknown");
    expect(c.message).toContain("exited with code 2");
    expect(c.message).toContain("some novel error");
  });

  it("falls back to unknown with a generic hint when no signal is present", () => {
    const c = classifyAgyError({ stdout: "", exitCode: 0 });
    expect(c.kind).toBe("unknown");
    expect(c.message).toMatch(/no usable output/i);
  });

  it("normalizes CRLF and case before matching", () => {
    const c = classifyAgyError({
      stderr: "USER LOCATION IS NOT SUPPORTED\r\n",
      exitCode: 0,
    });
    expect(c.kind).toBe("geo-blocked");
  });
});

describe("AgyRunError", () => {
  it("carries kind and model in the message", () => {
    const c = classifyAgyError({ log: GEO_LOG, exitCode: 0 });
    const err = new AgyRunError(c, "Gemini 3.5 Flash (High)");
    expect(err.kind).toBe("geo-blocked");
    expect(err.model).toBe("Gemini 3.5 Flash (High)");
    expect(err.message).toContain("[model: Gemini 3.5 Flash (High)]");
    expect(err.name).toBe("AgyRunError");
  });

  it("omits the model tag when no model was requested", () => {
    const c = classifyAgyError({ stdout: "", exitCode: 0 });
    const err = new AgyRunError(c);
    expect(err.message).not.toMatch(/\[model:/);
  });
});
