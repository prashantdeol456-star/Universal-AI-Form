import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";

/** A task with its ordered steps (the owner sees decrypted step output) and approvals. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await tasks().getTask(user, id), { headers: { "Cache-Control": "no-store" } });
});
