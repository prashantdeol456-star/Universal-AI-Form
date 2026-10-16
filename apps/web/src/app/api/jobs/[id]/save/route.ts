import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, route } from "@/server/http";
import { saveSchema } from "@/server/jobs/schemas";
import { saveJob } from "@/server/jobs/service";

type Ctx = { params: Promise<{ id: string }> };

/** Save / unsave a job, with notes, priority and shortlist flag. */
export const PUT = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  return json(await saveJob(user, id, await parseBody(req, saveSchema)));
});
