/**
 * Delta extraction across agy multi-turn continuations.
 *
 * When you pass `--conversation <id>` to `agy -p`, agy replays the full
 * transcript on each turn — so stdout contains the entire prior history PLUS
 * the new answer. For a long conversation this re-sends the whole context back
 * into the host's window every turn. extractDelta returns only the new part.
 *
 * Ported from raultov/opencode-agy-bridge's extractDelta (provider.ts), which
 * is the closest sanctioned prior art and ships tests/delta.test.ts. The
 * alignment falls through 5 stages of increasing leniency so a near-match
 * (whitespace, CRLF, trailing-newline differences) still extracts cleanly:
 *   1. CRLF→LF normalize both, then startsWith slice
 *   2. trimEnd then startsWith
 *   3. indexOf substring search (fullText may have a header before the replay)
 *   4. last-line + 150-char tail suffix search
 *   5. give up → return fullText (better to repeat than to drop the answer)
 *
 * Pure — fully unit-testable with no filesystem or agy dependency.
 */

function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

/**
 * Return the part of `fullText` that follows `prevOutput`, or the full text if
 * no alignment could be found. Never returns empty when fullText is non-empty.
 */
export function extractDelta(prevOutput: string, fullText: string): string {
  const full = normalize(String(fullText ?? ""));
  if (!full) return "";
  const prev = normalize(String(prevOutput ?? ""));
  if (!prev) return full;

  // Stage 1: full text starts with the previous output.
  if (full.startsWith(prev)) {
    return full.slice(prev.length).trimStart();
  }

  // Stage 2: trimEnd both (trailing whitespace drift).
  const fullTrim = full.trimEnd();
  const prevTrim = prev.trimEnd();
  if (fullTrim.startsWith(prevTrim)) {
    return fullTrim.slice(prevTrim.length).trimStart();
  }

  // Stage 3: the replay may be preceded by a header (e.g. agy's "Resuming
  // conversation..." line). Search for prev anywhere in full.
  const idx = full.indexOf(prev);
  if (idx !== -1) {
    return full.slice(idx + prev.length).trimStart();
  }

  // Stage 4: line-oriented suffix match. Find the last line of prev that
  // appears in full, then take everything after a short tail beyond it.
  const prevLines = prev.split("\n").filter((l) => l.trim().length > 0);
  if (prevLines.length > 0) {
    const lastLine = prevLines[prevLines.length - 1];
    const tailIdx = full.indexOf(lastLine);
    if (tailIdx !== -1) {
      const after = full.slice(tailIdx + lastLine.length);
      // Skip a small tail (up to 150 chars / 2 lines) that may differ before
      // the genuinely new content begins.
      const trimmed = after.split("\n").slice(0, 2).join("\n").slice(0, 150);
      const cutAt = after.length > trimmed.length ? after.indexOf(trimmed) + trimmed.length : 0;
      return after.slice(cutAt).trimStart();
    }
  }

  // Stage 5: no alignment — return the whole thing rather than dropping it.
  return full;
}
