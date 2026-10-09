import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { acceptAllNew } from "@/server/chat/service";
import { clientIp, json, route } from "@/server/http";

/** Saves every new (not conflicting) value from one assistant reply. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser("profile:write_own");
  return json(await acceptAllNew(user, z.uuid().parse((await params).id), clientIp(req)));
});
