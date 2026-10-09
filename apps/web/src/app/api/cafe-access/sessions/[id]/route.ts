import type { NextRequest } from "next/server";
import { z } from "zod";
import { CAFE_PERMISSIONS } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { approveSession, rejectSession, revokeMySession } from "@/server/cafe/customer";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    permissions: z.array(z.enum(CAFE_PERMISSIONS)).min(1).max(10),
    durationMinutes: z.number().int().min(15).max(720),
  }),
  z.object({ action: z.literal("reject") }),
  z.object({ action: z.literal("revoke") }),
]);

/** Customer approves (choosing categories and time), rejects, or revokes a café session. */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("privacy:manage_own");
  rateLimit("cafe-access", user.id, 60, 60_000);
  const id = z.uuid().parse((await params).id);
  const body = await parseBody(req, bodySchema);
  const ip = clientIp(req);
  if (body.action === "approve") return json(await approveSession(user, id, body, ip));
  if (body.action === "reject") return json(await rejectSession(user, id, ip));
  return json(await revokeMySession(user, id, ip));
});
