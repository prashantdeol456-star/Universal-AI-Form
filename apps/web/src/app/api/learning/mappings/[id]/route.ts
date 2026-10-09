import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";
import { forgetMapping } from "@/server/learning/service";

type Ctx = { params: Promise<{ id: string }> };

/** Forget one of your learned field mappings. */
export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("profile:write_own");
  rateLimit("learning-forget", user.id, 120, 60_000);
  return json(await forgetMapping(user, z.uuid().parse((await params).id)));
});
