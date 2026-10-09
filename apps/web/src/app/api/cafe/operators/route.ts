import type { NextRequest } from "next/server";
import { z } from "zod";
import { emailSchema } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { inviteOperator, listOperators } from "@/server/cafe/workspace";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser("cafe:operators_manage");
  return json({ operators: await listOperators(user) });
});

const bodySchema = z.object({ fullName: z.string().trim().min(1).max(200), email: emailSchema });

/** Owner invites an operator: a new work account + an e-mailed set-password link. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:operators_manage");
  rateLimit("cafe-invite", user.id, 10, 3_600_000);
  return json(await inviteOperator(user, await parseBody(req, bodySchema), clientIp(req)), { status: 201 });
});
