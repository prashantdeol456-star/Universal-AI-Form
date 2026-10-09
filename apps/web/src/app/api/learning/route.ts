import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";
import { learningOverview, setContribution } from "@/server/learning/service";

/** What the assistant learned from you, your contribution setting, and community knowledge counts. */
export const GET = route(async () => {
  const user = await requireUser("profile:read_own");
  return json(await learningOverview(user), { headers: { "Cache-Control": "no-store" } });
});

const bodySchema = z.object({ contributionEnabled: z.boolean() });

/** Opt in / out of contributing anonymised patterns. */
export const PATCH = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  rateLimit("learning-pref", user.id, 20, 60_000);
  const { contributionEnabled } = await parseBody(req, bodySchema);
  return json(await setContribution(user, contributionEnabled, clientIp(req)));
});
