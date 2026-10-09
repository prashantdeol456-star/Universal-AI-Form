import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { closeCafe } from "@/server/cafe/workspace";
import { clientIp, json, route } from "@/server/http";

/** Owner closes the café permanently. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:manage");
  return json(await closeCafe(user, clientIp(req)));
});
