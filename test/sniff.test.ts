import { describe, it, expect } from "vitest";
import { sniffImageFormat, isImageExt } from "../src/sniff.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x00, 0x00, 0x00, 0x00,
]);
const UNKNOWN = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

describe("sniffImageFormat", () => {
  it("detects PNG", () => {
    expect(sniffImageFormat(PNG)).toEqual({ ext: "png", mime: "image/png" });
  });
  it("detects JPEG", () => {
    expect(sniffImageFormat(JPEG)).toEqual({ ext: "jpg", mime: "image/jpeg" });
  });
  it("detects GIF", () => {
    expect(sniffImageFormat(GIF)).toEqual({ ext: "gif", mime: "image/gif" });
  });
  it("detects WEBP", () => {
    expect(sniffImageFormat(WEBP)).toEqual({ ext: "webp", mime: "image/webp" });
  });
  it("returns bin for an unrecognized signature", () => {
    expect(sniffImageFormat(UNKNOWN)).toEqual({ ext: "bin", mime: "application/octet-stream" });
  });
  it("returns bin for a too-short buffer", () => {
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toEqual({
      ext: "bin",
      mime: "application/octet-stream",
    });
  });
  it("does not throw on null/empty", () => {
    expect(() => sniffImageFormat(Buffer.alloc(0))).not.toThrow();
  });
});

describe("isImageExt", () => {
  it("accepts the common image extensions case-insensitively", () => {
    expect(isImageExt("png")).toBe(true);
    expect(isImageExt("JPG")).toBe(true);
    expect(isImageExt("webp")).toBe(true);
    expect(isImageExt("gif")).toBe(true);
    expect(isImageExt("bin")).toBe(false);
    expect(isImageExt("txt")).toBe(false);
  });
});
