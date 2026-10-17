import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, route } from "@/server/http";
import { deleteDraft, getDraft, updateDraft } from "@/server/messaging/intelligence";
import { draftPatchSchema } from "@/server/messaging/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await getDraft(user, id), { headers: { "Cache-Control": "no-store" } });
});

/** Edit the text (recipients never change), or mark a WhatsApp draft as copied / discard a draft. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await updateDraft(user, id, await parseBody(req, draftPatchSchema)));
});

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await deleteDraft(user, id);
  return json({ removed: true });
});
