import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  findProducedImage,
  moveProducedImage,
  runInScratch,
  type ScratchDeps,
} from "../src/scratch.js";

/**
 * In-memory ScratchDeps. The "scratch dir" is a Map<name, Buffer>; the op
 * writes into it, and moveProducedImage renames out of it. No real fs.
 */
function memScratch(files: Record<string, Buffer> = {}): ScratchDeps & {
  files: Map<string, Buffer>;
  moved: { src: string; dest: string }[];
  created: string[];
} {
  // Store keys normalized so path-separator differences (win32 backslash vs
  // posix forward slash) don't break the readdir/dirname comparison.
  const norm = (p: string) => path.normalize(p).replace(/\\/g, "/");
  const fileMap = new Map<string, Buffer>(
    Object.entries(files).map(([k, v]) => [norm(path.join("/scratch", k)), v]),
  );
  const moved: { src: string; dest: string }[] = [];
  const created: string[] = [];
  // Lookup that tolerates separator differences on either side.
  const lookup = (p: string) => fileMap.get(norm(p)) ?? fileMap.get(p);
  const deps: ScratchDeps = {
    mkdtemp: async (prefix) => {
      const dir = `${prefix}${created.length}`;
      created.push(dir);
      return dir;
    },
    readdir: async (dir) => {
      const dirNorm = norm(dir);
      return [...fileMap.keys()]
        .filter((k) => path.dirname(k).replace(/\\/g, "/") === dirNorm)
        .map((k) => path.basename(k));
    },
    rename: async (src, dest) => {
      const srcKey = [...fileMap.keys()].find((k) => k === norm(src)) ?? src;
      const buf = fileMap.get(srcKey);
      if (buf !== undefined) {
        fileMap.set(norm(dest), buf);
        fileMap.delete(srcKey);
      }
      moved.push({ src, dest });
    },
    copyFile: async (src, dest) => {
      const buf = lookup(src);
      if (buf !== undefined) fileMap.set(norm(dest), Buffer.from(buf));
    },
    rm: async () => {},
    stat: async (p) => {
      const buf = lookup(p);
      if (buf === undefined) return null;
      return { isFile: true, size: buf.length };
    },
    readHead: async (p, bytes) => {
      const buf = lookup(p);
      return buf ? buf.subarray(0, bytes) : null;
    },
  };
  return { ...deps, files: fileMap, moved, created };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

describe("findProducedImage", () => {
  it("returns the single image file in the scratch dir", async () => {
    const d = memScratch({ "out.png": PNG_BYTES, "notes.txt": Buffer.from("x") });
    const p = await findProducedImage("/scratch", d);
    expect(p).toBe(path.join("/scratch", "out.png"));
  });
  it("picks the largest when several images exist", async () => {
    const d = memScratch({
      "small.png": Buffer.alloc(10).fill(0x89),
      "big.jpg": Buffer.concat([JPEG_BYTES, Buffer.alloc(500)]),
    });
    const p = await findProducedImage("/scratch", d);
    expect(path.basename(p!)).toBe("big.jpg");
  });
  it("returns null when no image is present", async () => {
    const d = memScratch({ "readme.md": Buffer.from("x") });
    expect(await findProducedImage("/scratch", d)).toBeNull();
  });
  it("returns null when the dir is unreadable", async () => {
    const d: ScratchDeps = {
      ...memScratch(),
      readdir: async () => {
        throw new Error("ENOENT");
      },
    };
    expect(await findProducedImage("/scratch", d)).toBeNull();
  });
});

describe("moveProducedImage", () => {
  it("moves the file to the requested output path", async () => {
    const d = memScratch({ "out.png": PNG_BYTES });
    const report = await moveProducedImage(path.join("/scratch", "out.png"), "/final/cat.png", d);
    expect(report.status).toBe("moved");
    expect(report.finalPath).toBe("/final/cat.png");
    expect(report.reformat).toBe(false);
    expect(d.files.has("/final/cat.png")).toBe(true);
    expect(d.files.has(path.join("/scratch", "out.png"))).toBe(false);
  });

  it("reports missing when the source does not exist", async () => {
    const d = memScratch({});
    const report = await moveProducedImage(path.join("/scratch", "nope.png"), "/final/x.png", d);
    expect(report.status).toBe("missing");
  });

  it("renames the extension when bytes disagree with the path (JPEG saved as .png)", async () => {
    // agy returns JPEG regardless of requested extension — sniff and correct.
    const d = memScratch({ "out.png": JPEG_BYTES });
    const report = await moveProducedImage(path.join("/scratch", "out.png"), "/final/cat.png", d);
    expect(report.reformat).toBe(true);
    expect(report.finalPath).toBe("/final/cat.jpg");
    expect(d.files.has("/final/cat.jpg")).toBe(true);
  });

  it("keeps the extension when bytes match the path", async () => {
    const d = memScratch({ "out.png": PNG_BYTES });
    const report = await moveProducedImage(path.join("/scratch", "out.png"), "/final/cat.png", d);
    expect(report.reformat).toBe(false);
    expect(report.finalPath).toBe("/final/cat.png");
  });
});

describe("runInScratch", () => {
  // The op writes into the scratch dir using a normalized key so the mock's
  // readdir/dirname comparison matches across path separators.
  const normKey = (p: string) => path.normalize(p).replace(/\\/g, "/");

  it("creates a scratch dir, runs the op, moves the produced image, and reports", async () => {
    const d = memScratch();
    const op = async (scratchDir: string) => {
      // Simulate agy writing the image into the scratch dir.
      d.files.set(normKey(path.join(scratchDir, "gen.png")), PNG_BYTES);
    };
    const { moves } = await runInScratch(["/final/out.png"], op, d, "/tmp/prefix-");
    expect(moves).toHaveLength(1);
    expect(moves[0].status).toBe("moved");
    expect(moves[0].finalPath).toBe("/final/out.png");
    expect(d.files.has(normKey("/final/out.png"))).toBe(true);
  });

  it("returns empty moves when agy produced no image", async () => {
    const d = memScratch();
    const op = async () => {
      /* agy produced nothing */
    };
    const { moves } = await runInScratch(["/final/out.png"], op, d);
    expect(moves).toEqual([]);
  });

  it("copies to additional requested outputs after the first rename", async () => {
    const d = memScratch();
    const op = async (scratchDir: string) => {
      d.files.set(normKey(path.join(scratchDir, "gen.png")), PNG_BYTES);
    };
    const { moves } = await runInScratch(["/final/a.png", "/final/b.png"], op, d);
    expect(moves).toHaveLength(2);
    expect(moves[0].finalPath).toBe("/final/a.png");
    expect(moves[1].finalPath).toBe("/final/b.png");
    expect(d.files.has(normKey("/final/a.png"))).toBe(true);
    expect(d.files.has(normKey("/final/b.png"))).toBe(true);
  });
});
