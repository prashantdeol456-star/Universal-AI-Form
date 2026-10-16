import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";
import { refreshSource } from "@/server/jobs/service";

type Ctx = { params: Promise<{ id: string }> };

/** Re-reads a followed board (at most once per 10 minutes per board). */
export const POST = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  rateLimit("jobs-source", user.id, 10, 60_000);
  return json(await refreshSource(user, id));
});
