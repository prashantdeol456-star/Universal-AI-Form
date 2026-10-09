import type { NextRequest } from "next/server";
import { z } from "zod";
import { CAFE_PERMISSIONS } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { createAccessCode } from "@/server/cafe/customer";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  permissions: z.array(z.enum(CAFE_PERMISSIONS)).min(1).max(10),
  durationMinutes: z.number().int().min(15).max(720),
  purpose: z.string().max(200).nullish(),
});

/** Create a one-time café code (shown once; valid 15 minutes). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("privacy:manage_own");
  rateLimit("cafe-code", user.id, 10, 60 * 60_000);
  return json(await createAccessCode(user, await parseBody(req, bodySchema), clientIp(req)), { status: 201, headers: { "Cache-Control": "no-store" } });
});
