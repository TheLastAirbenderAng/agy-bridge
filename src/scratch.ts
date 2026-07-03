/**
 * Scratch-dir isolation for agy file-producing runs (image_gen).
 *
 * Why: agy snapshots every untracked file of any `--add-dir` repo on EVERY call
 * (slow), and its sandbox restricts write_file to the project's paths, causing
 * rejection→replan round-trips. Staging the run in a fresh tempdir + adding
 * ONLY that tempdir as --add-dir yields "0 snapshots + 0 rejections,
 * byte-identical output" — measured 15s→9s by MarcosNahuel/antigravity-plugin-cc.
 *
 * Pattern (mirrors MarcosNahuel agy_scratch.py + oh-my-agent oma-image):
 *   1. mkdtemp a scratch dir under os.tmpdir()
 *   2. run agy with --add-dir <scratch> only (NOT the project cwd)
 *   3. parse the produced file(s) inside scratch
 *   4. move each to its final absolute path
 *   5. report MOVED/MISSING per output; non-zero if any MISSING
 *
 * All fs ops are injectable so the staging + move + exit-code logic is unit-
 * testable with a fake agy that just writes files into the scratch dir.
 */
import { mkdtemp, readdir, rename, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sniffImageFormat, isImageExt } from "./sniff.js";

export interface ScratchDeps {
  mkdtemp: (prefix: string) => Promise<string>;
  readdir: (dir: string) => Promise<string[]>;
  rename: (src: string, dest: string) => Promise<void>;
  copyFile: (src: string, dest: string) => Promise<void>;
  rm: (target: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
  stat: (p: string) => Promise<{ isFile: boolean; size: number } | null>;
  /** Read enough bytes for sniffing (first 16 is plenty). Returns null if unreadable. */
  readHead: (p: string, bytes: number) => Promise<Buffer | null>;
}

export const defaultScratchDeps: ScratchDeps = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  readdir: (dir) => readdir(dir),
  rename: (src, dest) => rename(src, dest),
  copyFile: (src, dest) => copyFile(src, dest),
  rm: (target, opts) => rm(target, opts),
  stat: async (p) => {
    const { stat } = await import("node:fs/promises");
    try {
      const s = await stat(p);
      return { isFile: s.isFile(), size: s.size };
    } catch {
      return null;
    }
  },
  readHead: async (p, bytes) => {
    const { open } = await import("node:fs/promises");
    try {
      const h = await open(p, "r");
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await h.read(buf, 0, bytes, 0);
      await h.close();
      return buf.subarray(0, bytesRead);
    } catch {
      return null;
    }
  },
};

export interface MoveReport {
  /** The final absolute path the file was moved to. */
  finalPath: string;
  /** True if the bytes' real format differed from the requested extension and we renamed. */
  reformat: boolean;
  status: "moved" | "missing";
}

/**
 * Find the single image file agy produced inside `scratchDir`. If exactly one
 * image-ext file exists, returns its absolute path; if several, returns the
 * most-recently-suitable (largest); if none, returns null.
 */
export async function findProducedImage(
  scratchDir: string,
  deps: ScratchDeps = defaultScratchDeps,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await deps.readdir(scratchDir);
  } catch {
    return null;
  }
  const images = entries.filter((e) => isImageExt(path.extname(e).slice(1)));
  if (images.length === 0) return null;
  if (images.length === 1) return path.join(scratchDir, images[0]);
  // Several: pick the largest (the generated asset, vs thumbnails/metadata).
  let best: { p: string; size: number } | null = null;
  for (const name of images) {
    const p = path.join(scratchDir, name);
    const s = await deps.stat(p);
    if (s?.isFile && (!best || s.size > best.size)) best = { p, size: s.size };
  }
  return best?.p ?? null;
}

/**
 * Move a produced image to its final path, sniffing the real format and
 * correcting the extension when agy returned a different byte format than
 * requested (e.g. JPEG bytes saved as .png). Returns a MOVED report or a
 * MISSING report when the source doesn't exist.
 */
export async function moveProducedImage(
  srcInScratch: string,
  requestedOutput: string,
  deps: ScratchDeps = defaultScratchDeps,
): Promise<MoveReport> {
  const stat = await deps.stat(srcInScratch);
  if (!stat?.isFile) {
    return { finalPath: requestedOutput, reformat: false, status: "missing" };
  }

  // Sniff the real format; if it disagrees with the requested extension,
  // rewrite the output path's extension to match the bytes.
  let finalPath = requestedOutput;
  let reformat = false;
  const head = await deps.readHead(srcInScratch, 16);
  if (head) {
    const sniffed = sniffImageFormat(head);
    const requestedExt = path.extname(requestedOutput).slice(1).toLowerCase();
    if (sniffed.ext !== "bin" && sniffed.ext !== requestedExt) {
      finalPath = requestedOutput.replace(
        new RegExp(`${path.extname(requestedOutput)}$`),
        `.${sniffed.ext}`,
      );
      reformat = true;
    }
  }

  await deps.rename(srcInScratch, finalPath);
  return { finalPath, reformat, status: "moved" };
}

/**
 * One-shot helper: create a scratch dir, run an op with it, then locate +
 * move the produced image to its final path, and clean up the scratch dir.
 * The op receives the scratch dir path and should run agy with --add-dir
 * <scratchDir>. Returns the move report(s) for the requested output(s).
 *
 * If agy produced no image, returns an empty array (caller surfaces a warning).
 * Never throws on the agy/move path — cleanup is best-effort.
 */
export async function runInScratch(
  requestedOutputs: string[],
  op: (scratchDir: string) => Promise<void>,
  deps: ScratchDeps = defaultScratchDeps,
  prefix = path.join(tmpdir(), "agy-bridge-scratch-"),
): Promise<{ scratchDir: string; moves: MoveReport[] }> {
  const scratchDir = await deps.mkdtemp(prefix);
  try {
    await op(scratchDir);
    const produced = await findProducedImage(scratchDir, deps);
    const moves: MoveReport[] = [];
    if (produced) {
      // Move to the first requested output (additional outputs copy).
      for (let i = 0; i < requestedOutputs.length; i++) {
        const dest = requestedOutputs[i];
        if (i === 0) {
          moves.push(await moveProducedImage(produced, dest, deps));
        } else {
          // Source is gone after the first rename; copy from the final path.
          try {
            await deps.copyFile(moves[0].finalPath, dest);
            moves.push({ finalPath: dest, reformat: moves[0].reformat, status: "moved" });
          } catch {
            moves.push({ finalPath: dest, reformat: false, status: "missing" });
          }
        }
      }
    }
    return { scratchDir, moves };
  } finally {
    await deps.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
