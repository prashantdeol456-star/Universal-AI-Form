import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { resolveProposal } from "@/server/chat/service";
import { clientIp, json, parseBody, route } from "@/server/http";

const bodySchema = z.object({ action: z.enum(["accept", "reject"]) });

/** Accept (save to profile) or reject one value the assistant understood. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser("profile:write_own");
  const id = z.uuid().parse((await params).id);
  const { action } = await parseBody(req, bodySchema);
  return json({ proposal: await resolveProposal(user, id, action === "accept", clientIp(req)) });
});
