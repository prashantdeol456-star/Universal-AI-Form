import type { NextRequest } from "next/server";
import { z } from "zod";
import { modelAction } from "@/server/admin/models";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["stage", "promote", "disable"]), name: z.string().min(1).max(200) }),
  z.object({ action: z.literal("rollback") }),
]);

/**
 * Registry actions with the same gate as `npm run ml -- promote`. Never deploys:
 * the response says which LOCAL_AI_MODEL to set.
 */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("admin:models_manage");
  rateLimit("admin-models", user.id, 20, 60_000);
  const body = await parseBody(req, bodySchema);
  return json(await modelAction(user, "name" in body ? body.name : "", body.action));
});
