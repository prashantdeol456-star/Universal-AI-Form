import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { badRequest, json, rateLimit, route } from "@/server/http";
import { previewChatExport } from "@/server/messaging/whatsapp";

/** Reads a chat export the user picked WITHOUT storing it: who is in the chat (to pick "this is me"). */
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
  const dateOrder = z.enum(["dmy", "mdy", "auto"]).catch("auto").parse(form.get("dateOrder") ?? "auto");
  return json(await previewChatExport(file, dateOrder), { headers: { "Cache-Control": "no-store" } });
});
