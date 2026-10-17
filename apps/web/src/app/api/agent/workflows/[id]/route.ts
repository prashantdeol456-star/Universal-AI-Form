import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { deleteWorkflow, updateWorkflow } from "@/server/companion/memory";
import { companionEnabled } from "@/server/companion/planner";
import { workflowPatchSchema } from "@/server/companion/schemas";
import { json, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  const id = z.uuid().parse((await params).id);
  return json(await updateWorkflow(user, id, await parseBody(req, workflowPatchSchema)));
});

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  const id = z.uuid().parse((await params).id);
  return json(await deleteWorkflow(user, id));
});
