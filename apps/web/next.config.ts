import path from "node:path";
import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// One .env at the monorepo root serves the web app, DB CLI and scripts.
const rootEnv = path.join(import.meta.dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const config: NextConfig = {
  // Self-contained server bundle for the Docker image on the VPS.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@ufa/ai", "@ufa/form-engine", "@ufa/shared", "@ufa/security", "@ufa/profile-engine", "@ufa/db", "@ufa/storage", "@ufa/document-engine", "@ufa/tasks", "@ufa/jobs", "@ufa/messaging"],
  // Native / worker-thread packages run from node_modules, not the bundle.
  serverExternalPackages: ["tesseract.js", "sharp", "unpdf"],
  // Tesseract loads its worker script, WASM core and language data at runtime: ship them in the standalone build.
  outputFileTracingIncludes: {
    "/**/*": [
      "../../node_modules/tesseract.js/src/**/*",
      "../../node_modules/tesseract.js-core/*.{js,wasm}",
      "../../node_modules/@tesseract.js-data/eng/package.json",
      "../../node_modules/@tesseract.js-data/eng/4.0.0_best_int/*",
      "../../node_modules/@tesseract.js-data/hin/package.json",
      "../../node_modules/@tesseract.js-data/hin/4.0.0_best_int/*",
    ],
  },
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Pages and assets may not be embedded by other sites; the API stays reachable for the extension.
      { source: "/((?!api/).*)", headers: [{ key: "Cross-Origin-Resource-Policy", value: "same-origin" }] },
    ];
  },
};

export default config;
