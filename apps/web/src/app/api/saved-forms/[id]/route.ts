import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, route } from "@/server/http";
import { deleteSavedForm, updateSavedForm } from "@/server/saved-forms/service";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({ name: z.string().max(200).optional(), notes: z.string().max(1000).nullable().optional() })
  .refine((b) => b.name !== undefined || b.notes !== undefined, "Nothing to update");

export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("applications:manage_own");
  const id = z.uuid().parse((await params).id);
  return json(await updateSavedForm(user, id, await parseBody(req, bodySchema)));
});

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("applications:manage_own");
  const id = z.uuid().parse((await params).id);
  return json(await deleteSavedForm(user, id));
});
