import type { NextRequest } from "next/server";
import { z } from "zod";
import { cancelDeletion, requestDeletion } from "@/server/account/deletion";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({ password: z.string().min(1).max(128) });

/** Schedule permanent deletion of my account (password required). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("privacy:manage_own");
  rateLimit("account-delete", user.id, 5, 60 * 60_000);
  const { password } = await parseBody(req, bodySchema);
  return json(await requestDeletion(user, password, clientIp(req)));
});

/** Cancel a scheduled deletion. */
export const DELETE = route(async (req: NextRequest) => {
  const user = await requireUser("privacy:manage_own");
  return json(await cancelDeletion(user, clientIp(req)));
});
