import type { NextRequest } from "next/server";
import { companionEnabled } from "@/server/companion/planner";
import { pairPollSchema, pollSecretHeader } from "@/server/companion/schemas";
import { pollPairing } from "@/server/companion/service";
import { clientIp, json, parseBody, rateLimit, route, unauthorized } from "@/server/http";

/** The companion asks whether the user confirmed its code; the device token is handed out once. */
export const POST = route(async (req: NextRequest) => {
  companionEnabled();
  rateLimit("companion-pair-poll", clientIp(req), 120, 10 * 60_000);
  const secret = pollSecretHeader.safeParse(req.headers.get("authorization") ?? "");
  if (!secret.success) throw unauthorized("Poll secret required");
  const { pairingId } = await parseBody(req, pairPollSchema);
  return json(await pollPairing(pairingId, secret.data.slice(7)), { headers: { "Cache-Control": "no-store" } });
});
