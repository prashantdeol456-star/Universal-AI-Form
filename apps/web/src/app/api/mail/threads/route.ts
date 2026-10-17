import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";
import { searchMail } from "@/server/messaging/gmail";
import { mailSearchSchema } from "@/server/messaging/schemas";

/** Gmail search (one bounded page of threads, metadata only). Only after the user connected Gmail. */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("mail-search", user.id, 30, 60_000);
  const { pageToken, ...s } = mailSearchSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return json(await searchMail(user, s, pageToken ?? null), { headers: { "Cache-Control": "no-store" } });
});
