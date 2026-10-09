import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { redeemCode } from "@/server/cafe/workspace";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({ code: z.string().trim().min(8).max(20) });

/** Operator enters the customer's one-time code → active session. Tightly rate-limited against guessing. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:sessions_request");
  const ip = clientIp(req);
  rateLimit("cafe-redeem", user.id, 10, 10 * 60_000);
  rateLimit("cafe-redeem-ip", ip, 30, 10 * 60_000);
  const { code } = await parseBody(req, bodySchema);
  return json(await redeemCode(user, code, ip), { status: 201 });
});
