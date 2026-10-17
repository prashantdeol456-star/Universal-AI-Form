import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { addFeedback, listFeedback } from "@/server/jobs/feedback";
import { feedbackSchema } from "@/server/jobs/schemas";

type Ctx = { params: Promise<{ id: string }> };

/** The user's feedback on this job (votes and requirement corrections). */
export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await listFeedback(user, id), { headers: { "Cache-Control": "no-store" } });
});

/** "Was this match useful?" or a correction of a requirement read from the description. */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  rateLimit("jobs-feedback", user.id, 60, 60_000);
  return json(await addFeedback(user, id, await parseBody(req, feedbackSchema)), { status: 201 });
});
