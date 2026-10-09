import type { NextRequest } from "next/server";
import { z } from "zod";
import { setPattern } from "@/server/admin/learning";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ action: z.enum(["disable", "verify"]), reason: z.string().min(3).max(300) });

/** Switch a shared WEBSITE/GLOBAL pattern off (stays off) or mark it admin-verified. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("admin:learning_manage");
  const { action, reason } = await parseBody(req, bodySchema);
  return json(await setPattern(user, z.uuid().parse((await params).id), action, reason, clientIp(req)));
});
