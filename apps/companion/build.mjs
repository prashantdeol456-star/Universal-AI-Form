// Bundles the companion CLI into one file. Workspace packages (@ufa/*) are bundled; native or
// large libraries (sharp, OCR, PDF) stay external and load from the repository's node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/companion.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  external: ["sharp", "tesseract.js", "@tesseract.js-data/*", "unpdf"],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
