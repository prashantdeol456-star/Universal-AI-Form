import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { sendMessage } from "@/server/chat/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  sessionId: z.uuid().nullish(),
  content: z.string().trim().min(1, "Type a message").max(2000, "Message is too long (max 2000 characters)"),
});

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("chat:use");
  rateLimit("chat", user.id, 30, 60_000);
  const body = await parseBody(req, bodySchema);
  return json(await sendMessage(user, body), { headers: { "Cache-Control": "no-store" } });
});
