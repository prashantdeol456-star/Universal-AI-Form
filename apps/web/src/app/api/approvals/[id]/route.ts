import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";
import { kickTaskRunner } from "@/server/tasks/runner";
import { decisionSchema } from "@/server/tasks/schemas";

/** Approve or reject one pending approval of the signed-in user's own task. Decisions are final. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  rateLimit("approval-decide", user.id, 60, 10 * 60_000);
  const id = z.uuid().parse((await params).id);
  const { decision, note } = await parseBody(req, decisionSchema);
  const approval = await tasks().decideApproval(user, id, decision, note ?? null);
  if (approval.status === "approved") kickTaskRunner();
  return json({ approval: { id: approval.id, status: approval.status, decided_at: approval.decided_at } });
});
