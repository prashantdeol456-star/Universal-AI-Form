import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { addFeedback, listFeedback } from "@/server/companion/memory";
import { feedbackSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json({ feedback: await listFeedback(user, id) }, { headers: { "Cache-Control": "no-store" } });
});

/**
 * "Was this correct?" for a task. With scope "future" a matching preference may be suggested;
 * it is saved only if the user confirms it (a separate request).
 */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  rateLimit("task-feedback", user.id, 30, 10 * 60_000);
  const id = z.uuid().parse((await params).id);
  return json(await addFeedback(user, id, await parseBody(req, feedbackSchema)), { status: 201 });
});
