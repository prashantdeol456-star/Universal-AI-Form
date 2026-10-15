import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { assertSiteAllowed } from "@/server/sites/service";
import { tasks } from "@/server/tasks/engine";
import { kickTaskRunner } from "@/server/tasks/runner";

const bodySchema = z.object({ url: z.string().max(2048) });

/**
 * The user moved to the next page of a multi-page form themselves and continues the task
 * there. Same site only (checked by the task type) and only on a site the user allowed.
 */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  rateLimit("task-page", user.id, 60, 10 * 60_000);
  const id = z.uuid().parse((await params).id);
  const { url } = await parseBody(req, bodySchema);
  await assertSiteAllowed(user, url, "fill");
  const task = await tasks().addPage(user, id, url);
  kickTaskRunner();
  return json({ status: task.status });
});
