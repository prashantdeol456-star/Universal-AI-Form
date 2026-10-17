import type { NextRequest } from "next/server";
import { companionEnabled } from "@/server/companion/planner";
import { pairStartSchema, pollSecretHeader } from "@/server/companion/schemas";
import { startPairing } from "@/server/companion/service";
import { clientIp, json, parseBody, rateLimit, route, unauthorized } from "@/server/http";

/**
 * The companion starts pairing. No account is involved yet: it sends a poll secret it generated
 * (as a bearer value, hashed here) and gets a short code to show on the computer.
 */
export const POST = route(async (req: NextRequest) => {
  companionEnabled();
  rateLimit("companion-pair-start", clientIp(req), 10, 10 * 60_000);
  const secret = pollSecretHeader.safeParse(req.headers.get("authorization") ?? "");
  if (!secret.success) throw unauthorized("Poll secret required");
  const body = await parseBody(req, pairStartSchema);
  const r = await startPairing({ ...body, pollSecret: secret.data.slice(7) });
  return json(r, { status: 201, headers: { "Cache-Control": "no-store" } });
});
