#!/usr/bin/env node
/**
 * Builds the Chrome extension into apps/extension/dist (load it via chrome://extensions → "Load unpacked").
 *   npm run build -w @ufa/extension          one-off build
 *   npm run watch -w @ufa/extension          rebuild on change
 * Also writes dist/detector.js (dev-only, used by the test-form site; not referenced by the manifest).
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build, context } from "esbuild";
import sharp from "sharp";

const here = import.meta.dirname;
const src = path.join(here, "src");
const dist = path.join(here, "dist");
const watch = process.argv.includes("--watch");
const pkg = JSON.parse(await readFile(path.join(here, "package.json"), "utf8"));

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: "chrome116",
  logLevel: "info",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  legalComments: "none",
};

const entries = [
  { entryPoints: [path.join(src, "background.ts")], outfile: path.join(dist, "background.js"), format: "esm" },
  { entryPoints: [path.join(src, "content.ts")], outfile: path.join(dist, "content.js"), format: "iife" },
  { entryPoints: [path.join(src, "sidepanel/main.tsx")], outfile: path.join(dist, "sidepanel.js"), format: "iife", jsx: "automatic" },
  { entryPoints: [path.join(src, "detector-dev.ts")], outfile: path.join(dist, "detector.js"), format: "iife" },
];

async function staticFiles() {
  const manifest = JSON.parse(await readFile(path.join(src, "manifest.json"), "utf8"));
  manifest.version = pkg.version;
  await writeFile(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
  await copyFile(path.join(src, "sidepanel/sidepanel.html"), path.join(dist, "sidepanel.html"));
  await copyFile(path.join(src, "sidepanel/sidepanel.css"), path.join(dist, "sidepanel.css"));
  // Simple generated icon: a form card with a check mark.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
    <rect x="8" y="8" width="112" height="112" rx="26" fill="#2453e0"/>
    <rect x="30" y="32" width="68" height="10" rx="5" fill="#fff" opacity=".9"/>
    <rect x="30" y="54" width="48" height="10" rx="5" fill="#fff" opacity=".7"/>
    <path d="M40 86 l14 14 l32 -32" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  await mkdir(path.join(dist, "icons"), { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(dist, "icons", `icon${size}.png`));
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await staticFiles();

if (watch) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
  console.info("Watching for changes… (static files are copied once; restart to pick up manifest/html/css edits)");
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
  console.info(`Extension built: ${dist}`);
}
