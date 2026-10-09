import type { NextRequest } from "next/server";
import { z } from "zod";
import { adminUserAction } from "@/server/admin/users";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["suspend", "reactivate", "revoke_sessions"]), reason: z.string().min(3).max(300) }),
  z.object({ action: z.literal("set_role"), role: z.enum(["CUSTOMER", "CAFE_OWNER", "CAFE_OPERATOR"]), reason: z.string().min(3).max(300) }),
]);

/** Suspend / reactivate / sign out everywhere / change a non-admin role. Audited with a reason. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("admin:users_view");
  rateLimit("admin-user", user.id, 60, 60_000);
  const id = z.uuid().parse((await params).id);
  const { reason, ...action } = await parseBody(req, bodySchema);
  return json(await adminUserAction(user, id, action, reason, clientIp(req)));
});
