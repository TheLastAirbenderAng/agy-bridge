/**
 * Image format sniffing by magic bytes.
 *
 * agy's generate_image tool returns JPEG bytes regardless of the requested
 * filename extension (verified in oh-my-agent's antigravity provider). So an
 * `image_gen` call that asks for `cat.png` may produce a file whose bytes are
 * actually JPEG. sniffImageFormat inspects the leading bytes and returns the
 * true {ext, mime}; the caller renames the placeholder and sets the right MCP
 * mime type. Without this, a vision-capable host misreads the block.
 *
 * Pure buffer inspection — fully unit-testable with no filesystem.
 *
 * Signatures mirror oh-my-agent's oma-image sniff (PNG/JPEG/GIF/WEBP).
 */

export interface SniffedFormat {
  ext: "png" | "jpg" | "gif" | "webp" | "bin";
  mime: string;
}

const UNKNOWN: SniffedFormat = { ext: "bin", mime: "application/octet-stream" };

/**
 * Detect an image format from the first bytes of a buffer. Falls back to
 * {ext: 'bin'} when no known signature matches. Never throws.
 */
export function sniffImageFormat(buf: Buffer): SniffedFormat {
  if (!buf || buf.length < 4) return UNKNOWN;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // GIF: 47 49 46 38 (GIF8)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: "gif", mime: "image/gif" };
  }
  // WEBP: RIFF....WEBP — 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return UNKNOWN;
}

/**
 * Returns true when `ext` is a recognized image extension. Used to gate the
 * sniff+rename path so we only rewrite genuinely image-like outputs.
 */
export function isImageExt(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp"].includes(ext.toLowerCase());
}
