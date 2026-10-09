/**
 * Live check of the Gemini configuration (key, model, request format) with one tiny request.
 * Sends two made-up field labels only — no user data. Usage: npm run check:gemini
 */
import { existsSync } from "node:fs";
import { GeminiProvider } from "../packages/ai/src/providers/gemini";
import { PROFILE_FIELDS } from "@ufa/shared";

if (existsSync(".env")) process.loadEnvFile(".env");
const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
if (!apiKey) {
  console.error("GEMINI_API_KEY is not set (.env or environment).");
  process.exit(1);
}

async function main() {
  const provider = new GeminiProvider({ apiKey: apiKey!, model, baseUrl: process.env.GEMINI_BASE_URL || undefined });
  const started = Date.now();
  const { suggestions, usage } = await provider.mapFields({
    candidates: PROFILE_FIELDS.map((d) => ({ key: d.key, label: d.label.en })),
    fields: [
      { id: "a", label: "Janm tithi", section: "Personal", kind: "date", options: [] },
      { id: "b", label: "Preferred examination centre", section: null, kind: "select", options: ["Delhi", "Patna"] },
    ],
  });
  console.log(`Gemini OK — model ${model}, ${Date.now() - started} ms, tokens in/out ${usage?.inputTokens ?? "?"}/${usage?.outputTokens ?? "?"}`);
  for (const s of suggestions) console.log(`  ${s.fieldId}: ${s.profileField ?? "none"} (${s.confidence})`);
  console.log(process.env.GEMINI_ENABLED === "true" ? "GEMINI_ENABLED=true — the app will use it." : "Note: GEMINI_ENABLED is not true, so the app will not call Gemini.");
}

main().catch((e: Error) => {
  console.error(`Gemini check failed: ${e.message}`);
  console.error("HTTP 400 → request format/model; 401/403 → key; 404 → model name not available to this key (see GEMINI_MODEL).");
  process.exit(1);
});
