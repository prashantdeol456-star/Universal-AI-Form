import type { NextRequest } from "next/server";
import { z } from "zod";
import { deleteSavedAnswer, updateSavedAnswer } from "@/server/agent/service";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("profile:write_own");
  const id = z.uuid().parse((await params).id);
  const { answer } = await parseBody(req, z.object({ answer: z.string().max(5000) }));
  await updateSavedAnswer(user, id, answer);
  return json({ ok: true });
});

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("profile:write_own");
  await deleteSavedAnswer(user, z.uuid().parse((await params).id));
  return json({ ok: true });
});
