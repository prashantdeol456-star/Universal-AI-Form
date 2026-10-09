import type { NextRequest } from "next/server";
import { z } from "zod";
import { CAFE_PERMISSIONS } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { requestAccess } from "@/server/cafe/workspace";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  identifier: z.string().trim().min(5).max(254),
  permissions: z.array(z.enum(CAFE_PERMISSIONS)).min(1).max(10),
  purpose: z.string().max(200).nullish(),
});

/** Ask a customer (by registered email or mobile) for access. Same answer whether or not they exist. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:sessions_request");
  rateLimit("cafe-request", user.id, 20, 3_600_000);
  return json(await requestAccess(user, await parseBody(req, bodySchema), clientIp(req)));
});
