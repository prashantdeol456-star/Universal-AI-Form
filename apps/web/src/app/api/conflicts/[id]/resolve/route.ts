import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { resolveConflict } from "@/server/documents/service";
import { clientIp, json, parseBody, route } from "@/server/http";

const bodySchema = z
  .object({ chosenIndex: z.number().int().min(0).max(50).optional(), customValue: z.string().max(2000).optional() })
  .refine((b) => b.chosenIndex !== undefined || b.customValue?.trim(), "Choose a value or enter the correct one");

export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser("profile:write_own");
  const id = z.uuid().parse((await params).id);
  await resolveConflict(user, id, await parseBody(req, bodySchema), clientIp(req));
  return json({ ok: true });
});
