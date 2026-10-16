import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, route } from "@/server/http";
import { applicationSchema } from "@/server/jobs/schemas";
import { updateApplication } from "@/server/jobs/service";

type Ctx = { params: Promise<{ id: string }> };

/** Manual application tracking. "Applied" and later need the confirmation that the user submitted it themselves. */
export const PUT = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await updateApplication(user, id, await parseBody(req, applicationSchema), clientIp(req)));
});
