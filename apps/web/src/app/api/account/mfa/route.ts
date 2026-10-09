import type { NextRequest } from "next/server";
import { z } from "zod";
import { disableMfa, enableMfa, mfaStatus, startMfaSetup } from "@/server/auth/mfa";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  return json(await mfaStatus(user.id));
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setup") }),
  z.object({ action: z.literal("enable"), password: z.string().min(1).max(128), code: z.string().trim().min(6).max(20) }),
  z.object({ action: z.literal("disable"), password: z.string().min(1).max(128), code: z.string().trim().min(6).max(20) }),
]);

/** Set up / turn on / turn off two-step verification. Responses contain secrets: never cached. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("mfa", user.id, 10, 15 * 60_000);
  const body = await parseBody(req, bodySchema);
  const ip = clientIp(req);
  const headers = { "Cache-Control": "no-store" };
  if (body.action === "setup") return json(await startMfaSetup(user.id, user.email), { headers });
  if (body.action === "enable") return json(await enableMfa(user.id, user.role, body.password, body.code, ip), { headers });
  return json(await disableMfa(user.id, user.role, body.password, body.code, ip), { headers });
});
