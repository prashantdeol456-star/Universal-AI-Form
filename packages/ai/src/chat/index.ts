import { extractChatFacts, type ChatFact } from "./facts";
import { detectIntent, detectQueryFields, type ChatIntent } from "./intent";
import { detectLanguage, type ChatLanguage } from "./language";
import type { ChatLocalAIExtractor } from "./localAi";

export * from "./facts";
export * from "./intent";
export * from "./language";
export * from "./replies";
export * from "./redact";
export * from "./dates";
export * from "./localAi";

export interface MessageAnalysis {
  language: ChatLanguage;
  intent: ChatIntent;
  facts: ChatFact[];
  queryFields: string[];
  localAiUsed: boolean;
  localAiError?: string;
}

/**
 * Understands one user message: rules first; the optional local model is only
 * consulted when rules found nothing and the message is not a question/greeting.
 */
export async function analyzeMessage(text: string, localAi?: ChatLocalAIExtractor | null): Promise<MessageAnalysis> {
  const language = detectLanguage(text);
  let facts = extractChatFacts(text);
  let intent = detectIntent(text, facts.length > 0);
  let localAiUsed = false;
  let localAiError: string | undefined;

  if (intent === "UNKNOWN" && localAi) {
    try {
      facts = await localAi.extract(text);
      localAiUsed = true;
      if (facts.length) intent = "UPDATE";
    } catch (err) {
      localAiError = err instanceof Error ? err.message : String(err);
    }
  }
  return { language, intent, facts, queryFields: intent === "QUERY" ? detectQueryFields(text) : [], localAiUsed, localAiError };
}
