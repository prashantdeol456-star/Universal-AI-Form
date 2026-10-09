import type { NextRequest } from "next/server";
import { z } from "zod";
import { setCafeStatus } from "@/server/admin/cafes";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]), reason: z.string().min(3).max(300) });

/** Suspend (ends all its customer sessions) or reactivate a café. Audited. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("admin:users_view");
  const { status, reason } = await parseBody(req, bodySchema);
  return json(await setCafeStatus(user, z.uuid().parse((await params).id), status, reason, clientIp(req)));
});
