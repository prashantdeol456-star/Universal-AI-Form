import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";
import { analyzeJob } from "@/server/jobs/analysis";

type Ctx = { params: Promise<{ id: string }> };

/** AI summary of the public job text (no personal data is sent). */
export const POST = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  rateLimit("jobs-analyze", user.id, 10, 60_000);
  return json(await analyzeJob(user, id), { headers: { "Cache-Control": "no-store" } });
});
