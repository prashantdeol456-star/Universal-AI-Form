import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { deleteFeedback } from "@/server/jobs/feedback";

type Ctx = { params: Promise<{ id: string }> };

/** Deletes one piece of feedback (a deleted correction no longer affects the job's score). */
export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await deleteFeedback(user, id);
  return json({ removed: true });
});
