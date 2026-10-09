import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, route } from "@/server/http";
import { listNotifications, markRead } from "@/server/notifications";

export const GET = route(async () => {
  const user = await requireUser();
  return json(await listNotifications(user), { headers: { "Cache-Control": "no-store" } });
});

const bodySchema = z.object({ ids: z.union([z.literal("all"), z.array(z.uuid()).min(1).max(100)]) });

/** Mark notifications as read. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  const { ids } = await parseBody(req, bodySchema);
  return json(await markRead(user, ids));
});
