import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { endSession } from "@/server/cafe/workspace";
import { clientIp, json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** The café ends a session early (when the customer leaves). */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("cafe:sessions_request");
  return json(await endSession(user, z.uuid().parse((await params).id), clientIp(req)));
});
