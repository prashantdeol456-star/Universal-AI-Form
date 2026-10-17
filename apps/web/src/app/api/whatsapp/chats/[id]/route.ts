import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, route } from "@/server/http";
import { chatPatchSchema } from "@/server/messaging/schemas";
import { chatMessages, deleteChat, updateChat } from "@/server/messaging/whatsapp";

type Ctx = { params: Promise<{ id: string }> };

/** Messages of one imported chat (latest 200, or before ?beforeSeq=). */
export const GET = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  const beforeSeq = z.coerce.number().int().min(1).optional().parse(req.nextUrl.searchParams.get("beforeSeq") ?? undefined);
  return json(await chatMessages(user, id, { beforeSeq }), { headers: { "Cache-Control": "no-store" } });
});

/** Per-chat cloud AI consent and retention. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await updateChat(user, id, await parseBody(req, chatPatchSchema), clientIp(req)));
});

/** Deletes the chat, its messages, drafts and summaries. */
export const DELETE = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await deleteChat(user, id, clientIp(req));
  return json({ removed: true });
});
