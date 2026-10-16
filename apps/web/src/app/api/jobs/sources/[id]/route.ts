import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { removeSource } from "@/server/jobs/service";

type Ctx = { params: Promise<{ id: string }> };

/** Stop following a board (its jobs stay; they are no longer refreshed). */
export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await removeSource(user, id);
  return json({ removed: true });
});
