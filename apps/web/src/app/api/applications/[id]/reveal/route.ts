import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { revealApplicationValues } from "@/server/applications/history";
import { clientIp, json, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** Full (unmasked) snapshot values for the owner. Audited. */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("applications:manage_own");
  rateLimit("application-reveal", user.id, 20, 60_000);
  const id = z.uuid().parse((await params).id);
  return json({ values: await revealApplicationValues(user, id, clientIp(req)) }, { headers: { "Cache-Control": "no-store" } });
});
