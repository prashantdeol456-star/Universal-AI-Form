import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { deleteInsight } from "@/server/messaging/intelligence";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await deleteInsight(user, id);
  return json({ removed: true });
});
