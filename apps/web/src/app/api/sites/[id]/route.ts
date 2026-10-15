import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, route } from "@/server/http";
import { revokeSite } from "@/server/sites/service";

/** Removes the assistant's access to a site. */
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await revokeSite(user, id, clientIp(req));
  return json({ ok: true });
});
