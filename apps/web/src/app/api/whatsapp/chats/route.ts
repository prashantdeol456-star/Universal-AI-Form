import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { badRequest, clientIp, json, rateLimit, route } from "@/server/http";
import { importFields } from "@/server/messaging/schemas";
import { importChat, listChats } from "@/server/messaging/whatsapp";

export const GET = route(async () => {
  const user = await requireUser();
  return json({ chats: await listChats(user) }, { headers: { "Cache-Control": "no-store" } });
});

/** Imports one chat export the user picked (stored encrypted, deleted after its retention date). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("whatsapp-import", user.id, 30, 60 * 60_000);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest("Expected a file upload");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Choose the exported .txt file");
  const fields = importFields.parse({ myName: form.get("myName"), title: form.get("title"), dateOrder: form.get("dateOrder") ?? undefined, retentionDays: form.get("retentionDays") || null });
  return json(await importChat(user, { file, ...fields, title: fields.title ?? null }, clientIp(req)), { status: 201 });
});
