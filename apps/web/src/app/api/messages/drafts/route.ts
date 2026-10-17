import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { listDrafts } from "@/server/messaging/intelligence";
import { draftQuerySchema } from "@/server/messaging/schemas";

/** The user's reply drafts (email and WhatsApp). */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  const q = draftQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return json({ drafts: await listDrafts(user, q) }, { headers: { "Cache-Control": "no-store" } });
});
