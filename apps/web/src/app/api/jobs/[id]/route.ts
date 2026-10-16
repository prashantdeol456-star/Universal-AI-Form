import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { getJob, removeJob } from "@/server/jobs/service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await getJob(user, id), { headers: { "Cache-Control": "no-store" } });
});

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await removeJob(user, id);
  return json({ removed: true });
});
