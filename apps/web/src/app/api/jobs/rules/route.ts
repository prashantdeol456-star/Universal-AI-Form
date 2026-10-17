import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { addRule } from "@/server/jobs/feedback";
import { ruleSchema } from "@/server/jobs/schemas";

/** A ranking rule the user writes or approves (changes the order of jobs, never their fit score). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("jobs-feedback", user.id, 60, 60_000);
  return json(await addRule(user, await parseBody(req, ruleSchema)), { status: 201 });
});
