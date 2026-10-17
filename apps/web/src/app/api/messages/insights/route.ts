import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { listInsights } from "@/server/messaging/intelligence";
import { insightQuerySchema } from "@/server/messaging/schemas";

/** Saved summaries of one conversation (the user's own; deletable). */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  const q = insightQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return json({ insights: await listInsights(user, q.source, q.ref) }, { headers: { "Cache-Control": "no-store" } });
});
