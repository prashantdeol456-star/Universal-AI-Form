import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { listSavedForms, saveForm } from "@/server/saved-forms/service";

export const GET = route(async () => {
  const user = await requireUser("applications:manage_own");
  return json({ forms: await listSavedForms(user) }, { headers: { "Cache-Control": "no-store" } });
});

const bodySchema = z.object({
  name: z.string().max(200),
  url: z.string().min(1).max(2000),
  notes: z.string().max(1000).nullish(),
  formSignatureId: z.uuid().nullish(),
});

/** Saves a form (dashboard or the extension's "Save this form"); idempotent per URL. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("applications:manage_own");
  rateLimit("saved-forms", user.id, 30, 60_000);
  const r = await saveForm(user, await parseBody(req, bodySchema));
  return json(r, { status: r.created ? 201 : 200 });
});
