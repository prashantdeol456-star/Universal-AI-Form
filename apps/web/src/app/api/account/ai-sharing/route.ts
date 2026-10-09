import type { NextRequest } from "next/server";
import { z } from "zod";
import { setProfileSharing } from "@/server/agent/service";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, route } from "@/server/http";

/** Consent to send the professional profile (summary, skills, job, education) to the cloud AI for written answers. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  const { enabled } = await parseBody(req, z.object({ enabled: z.boolean() }));
  return json(await setProfileSharing(user, enabled, clientIp(req)));
});
