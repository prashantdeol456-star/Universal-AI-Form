import { copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { DetectedType } from "./fileType";

/**
 * Text extraction:
 *  - PDFs with a text layer: read directly (pdf.js via unpdf) — exact, fast.
 *  - Images: sharp preprocessing (EXIF rotate, grayscale, normalize, upscale) + Tesseract (English + Hindi).
 *  - Scanned PDFs (no text layer): reported as ScannedPdfError so the UI can ask for a photo/scan image instead.
 *    Rasterising PDFs for OCR is a planned improvement.
 * Tesseract language data ships inside npm packages; nothing is downloaded at runtime.
 */
export interface TextResult {
  text: string;
  engine: "pdf-text" | "tesseract";
  confidence: number | null;
  pages?: number;
}

export class ScannedPdfError extends Error {
  constructor() {
    super("This PDF has no text layer (it is a scan). Upload a clear photo or image scan instead.");
    this.name = "ScannedPdfError";
  }
}

export async function imageInfo(buf: Buffer): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(buf).metadata();
    return m.width && m.height ? { width: m.width, height: m.height } : null;
  } catch {
    return null;
  }
}

async function pdfText(buf: Buffer): Promise<TextResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  const merged = Array.isArray(text) ? text.join("\n") : text;
  if (merged.replace(/\s/g, "").length < 30) throw new ScannedPdfError();
  return { text: merged, engine: "pdf-text", confidence: null, pages: totalPages };
}

/** Grayscale, auto-rotate, contrast-normalize, and upscale small images for better OCR. */
export async function preprocessForOcr(buf: Buffer): Promise<Buffer> {
  const img = sharp(buf, { limitInputPixels: 60_000_000 }).rotate().grayscale().normalize();
  const meta = await sharp(buf).metadata();
  const width = meta.width ?? 0;
  const resized = width > 0 && width < 1600 ? img.resize({ width: 1600 }) : width > 4000 ? img.resize({ width: 4000 }) : img;
  return resized.png().toBuffer();
}

// --- Tesseract worker (one per process, jobs serialized) ----------------------
type TesseractWorker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;
let workerPromise: Promise<TesseractWorker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Copies the bundled eng + hin traineddata (.gz, from @tesseract.js-data/*) into one
 * directory so tesseract.js can load both from a local langPath. Fully offline.
 */
async function prepareLangDir(): Promise<string> {
  const require = createRequire(import.meta.url);
  const dir = path.join(tmpdir(), "ufa-tessdata-4.0.0_best_int");
  await mkdir(dir, { recursive: true });
  for (const code of ["eng", "hin"]) {
    const target = path.join(dir, `${code}.traineddata.gz`);
    if (await stat(target).then((s) => s.size > 0, () => false)) continue;
    const pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`));
    // LSTM "best_int" models: good accuracy, fast on CPU.
    await copyFile(path.join(pkgDir, "4.0.0_best_int", `${code}.traineddata.gz`), target);
  }
  return dir;
}

async function getWorker(): Promise<TesseractWorker> {
  workerPromise ??= (async () => {
    const { createWorker, OEM } = await import("tesseract.js");
    const langPath = await prepareLangDir();
    return createWorker(["eng", "hin"], OEM.LSTM_ONLY, {
      langPath,
      gzip: true,
      cacheMethod: "none",
      errorHandler: () => {}, // errors surface through the rejected job promise instead of crashing the process
    });
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

export async function shutdownOcr() {
  const w = workerPromise;
  workerPromise = null;
  if (w) await (await w).terminate().catch(() => {});
}

async function ocrImage(buf: Buffer, timeoutMs: number): Promise<TextResult> {
  const prepared = await preprocessForOcr(buf);
  const run = async () => {
    const worker = await getWorker();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        worker.recognize(prepared),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("OCR timed out")), timeoutMs);
        }),
      ]);
      return { text: result.data.text, engine: "tesseract" as const, confidence: result.data.confidence / 100 };
    } catch (err) {
      await shutdownOcr(); // a stuck worker is replaced on the next job
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}

export async function extractText(buf: Buffer, type: DetectedType, opts: { timeoutMs?: number } = {}): Promise<TextResult> {
  return type.kind === "pdf" ? pdfText(buf) : ocrImage(buf, opts.timeoutMs ?? 120_000);
}
