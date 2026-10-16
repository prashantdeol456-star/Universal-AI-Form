import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";
import { addSourceSchema } from "@/server/jobs/schemas";
import { addSource, listSources } from "@/server/jobs/service";

export const GET = route(async () => {
  const user = await requireUser();
  return json({ sources: await listSources(user) }, { headers: { "Cache-Control": "no-store" } });
});

/** Follow a public Greenhouse or Lever job board (read once now). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("jobs-source", user.id, 10, 60_000);
  return json(await addSource(user, await parseBody(req, addSourceSchema), clientIp(req)), { status: 201 });
});
