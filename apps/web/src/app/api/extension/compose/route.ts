import { COMPOSE_LANGUAGES, COMPOSE_TONES, MAX_BODY, MAX_SUBJECT } from "@ufa/ai";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { composeEmail } from "@/server/compose/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  instruction: z.string().trim().min(3).max(1000),
  tone: z.enum(COMPOSE_TONES).default("formal"),
  language: z.enum(COMPOSE_LANGUAGES).default("en"),
  previous: z.object({ subject: z.string().max(MAX_SUBJECT), body: z.string().min(1).max(MAX_BODY) }).nullish(),
});

/** Drafts an email from the user's request and own profile ("Write email" in the extension). Never sends anything. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:read_own");
  rateLimit("compose", user.id, 20, 10 * 60_000);
  const input = await parseBody(req, bodySchema);
  // Contains the user's own profile values: never cache.
  return json(await composeEmail(user, input), { headers: { "Cache-Control": "no-store" } });
});
