import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, rateLimit, route } from "@/server/http";
import { withdrawContributions } from "@/server/learning/service";

/** Stop contributing and withdraw all examples contributed so far. Audited. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("privacy:manage_own");
  rateLimit("learning-withdraw", user.id, 5, 60_000);
  return json(await withdrawContributions(user, clientIp(req)));
});
