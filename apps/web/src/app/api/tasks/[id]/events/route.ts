import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";
import { eventsQuery } from "@/server/tasks/schemas";

/** Task history, newest first; `before` is the id of the last event of the previous page. */
export const GET = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  const q = eventsQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
  return json(await tasks().listEvents(user, id, { limit: q.limit, beforeId: q.before ?? null }), { headers: { "Cache-Control": "no-store" } });
});
