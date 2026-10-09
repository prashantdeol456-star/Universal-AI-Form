import type { NextRequest } from "next/server";
import { z } from "zod";
import { fieldKeySchema } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";
import { revealField } from "@/server/profile/service";

// POST (not GET) so sensitive values never appear in URLs, logs or caches.
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:read_own");
  rateLimit("reveal", user.id, 30, 60_000);
  const { fieldKey } = await parseBody(req, z.object({ fieldKey: fieldKeySchema }));
  const value = await revealField(user, fieldKey, clientIp(req));
  return json({ value }, { headers: { "Cache-Control": "no-store" } });
});
