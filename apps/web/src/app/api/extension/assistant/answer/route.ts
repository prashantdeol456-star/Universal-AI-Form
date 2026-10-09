import type { NextRequest } from "next/server";
import { z } from "zod";
import { answerQuestion } from "@/server/agent/service";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(5000),
  profileFieldKey: z.string().max(120).nullish(),
  kind: z.string().max(40).nullish(),
  domain: z.string().max(253).nullish(),
});

/** The user's answer to a form question: saved to the profile field, or to saved answers for next time. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  rateLimit("assistant-answer", user.id, 120, 10 * 60_000);
  const input = await parseBody(req, bodySchema);
  return json(await answerQuestion(user, input, clientIp(req)), { headers: { "Cache-Control": "no-store" } });
});
