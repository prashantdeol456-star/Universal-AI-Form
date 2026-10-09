import type { NextRequest } from "next/server";
import { z } from "zod";
import { absorbMessage } from "@/server/agent/service";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({ text: z.string().trim().min(1).max(2000) });

/** Something the user told the assistant: everyday facts go into their profile. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  rateLimit("assistant-msg", user.id, 60, 10 * 60_000);
  const { text } = await parseBody(req, bodySchema);
  return json(await absorbMessage(user, text, clientIp(req)), { headers: { "Cache-Control": "no-store" } });
});
