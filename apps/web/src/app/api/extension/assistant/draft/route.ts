import type { NextRequest } from "next/server";
import { z } from "zod";
import { draftAnswer } from "@/server/agent/service";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  question: z.string().trim().min(3).max(1000),
  role: z.string().trim().max(120).nullish(),
  maxWords: z.number().int().min(10).max(2000).nullish(),
});

/** Draft answer to an open question ("Tell us about yourself") from the user's professional profile. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:read_own");
  rateLimit("assistant-draft", user.id, 30, 10 * 60_000);
  const input = await parseBody(req, bodySchema);
  return json(await draftAnswer(user, input), { headers: { "Cache-Control": "no-store" } });
});
