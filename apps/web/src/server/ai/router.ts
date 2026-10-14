import "server-only";
import { GeminiProvider, LocalAIProvider, ModelRouter } from "@ufa/ai";
import { env } from "../env";

/**
 * The server's single model router: one local provider and one Gemini provider, built from
 * env. The Gemini key is read only here, on the server; it is never sent to the extension.
 */
const g = globalThis as unknown as { __ufaModelRouter?: ModelRouter };

export function modelRouter(): ModelRouter {
  if (g.__ufaModelRouter) return g.__ufaModelRouter;
  const e = env();
  const local = e.LOCAL_AI_ENABLED
    ? new LocalAIProvider({ baseUrl: e.LOCAL_AI_BASE_URL, model: e.LOCAL_AI_MODEL, embedModel: e.LOCAL_AI_EMBED_MODEL || undefined, apiKey: e.LOCAL_AI_API_KEY, timeoutMs: 60_000 })
    : null;
  const gemini =
    e.GEMINI_ENABLED && e.GEMINI_API_KEY
      ? new GeminiProvider({ apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL, baseUrl: e.GEMINI_BASE_URL, batchSize: e.GEMINI_MAX_FIELDS_PER_REQUEST })
      : null;
  if (e.GEMINI_ENABLED && !e.GEMINI_API_KEY) console.warn("[ai] GEMINI_ENABLED is true but GEMINI_API_KEY is empty: Gemini fallback is off");
  g.__ufaModelRouter = new ModelRouter({ mode: e.AI_ROUTING_MODE, local, gemini });
  return g.__ufaModelRouter;
}
