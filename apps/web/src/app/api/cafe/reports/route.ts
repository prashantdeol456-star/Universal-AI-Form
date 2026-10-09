import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { cafeReport } from "@/server/cafe/workspace";
import { json, route } from "@/server/http";

/** Owner report: counts and form metadata per operator/day — never customers' values. ?days=1..365 */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:reports_view");
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30) || 30;
  return json(await cafeReport(user, days), { headers: { "Cache-Control": "no-store" } });
});
