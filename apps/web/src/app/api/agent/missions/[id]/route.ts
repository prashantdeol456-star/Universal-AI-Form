import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { deleteMission, getMission } from "@/server/companion/missions";
import { companionEnabled } from "@/server/companion/planner";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  const id = z.uuid().parse((await params).id);
  return json(await getMission(user, id), { headers: { "Cache-Control": "no-store" } });
});

/** Deletes a planned or finished mission (its tasks stay in Tasks). */
export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  const id = z.uuid().parse((await params).id);
  return json(await deleteMission(user, id));
});
