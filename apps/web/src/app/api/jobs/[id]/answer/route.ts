import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { answerFromKnowledge } from "@/server/knowledge/answer";
import { answerSchema } from "@/server/jobs/schemas";
import { getJob } from "@/server/jobs/service";

type Ctx = { params: Promise<{ id: string }> };

/** Draft answer to an application question from the user's own documents, with cited excerpts. */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  rateLimit("knowledge-answer", user.id, 20, 60_000);
  const { question } = await parseBody(req, answerSchema);
  await getJob(user, id); // the job must be the caller's own
  return json(await answerFromKnowledge(user, { question, mode: "draft" }), { headers: { "Cache-Control": "no-store" } });
});
