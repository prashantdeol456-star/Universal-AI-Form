import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { updateApplication } from "@/server/applications/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    status: z.enum(["SUBMITTED", "CANCELLED"]).optional(),
    applicationNumber: z.string().max(100).nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.applicationNumber !== undefined, "Nothing to update");

/** "I submitted this form" / cancel / add the portal's application number. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("applications:manage_own");
  rateLimit("application-update", user.id, 60, 60_000);
  const id = z.uuid().parse((await params).id);
  return json(await updateApplication(user, id, await parseBody(req, bodySchema)));
});
