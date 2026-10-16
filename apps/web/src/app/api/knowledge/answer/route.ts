import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { answerFromKnowledge } from "@/server/knowledge/answer";

const body = z.object({ question: z.string().trim().min(2).max(300), mode: z.enum(["fact", "draft"]).optional() }).strict();

/** Answers from the user's own documents with cited excerpts (AI only within the user's consent). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("documents:manage_own");
  rateLimit("knowledge-answer", user.id, 20, 60_000);
  const input = await parseBody(req, body);
  return json(await answerFromKnowledge(user, input), { headers: { "Cache-Control": "no-store" } });
});
