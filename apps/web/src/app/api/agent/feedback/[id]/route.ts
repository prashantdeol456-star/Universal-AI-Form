import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { deleteFeedback } from "@/server/companion/memory";
import { companionEnabled } from "@/server/companion/planner";
import { json, route } from "@/server/http";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  return json(await deleteFeedback(user, z.uuid().parse((await params).id)));
});
