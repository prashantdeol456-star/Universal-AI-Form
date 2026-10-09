import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { searchApplications } from "@/server/applications/history";
import { json, route } from "@/server/http";

/** Application history: ?q=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD&page= */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser("applications:manage_own");
  const p = req.nextUrl.searchParams;
  const result = await searchApplications(user, {
    q: p.get("q") ?? undefined,
    status: p.get("status") ?? undefined,
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
    page: Number(p.get("page") ?? 1) || 1,
    pageSize: Number(p.get("pageSize") ?? 20) || 20,
  });
  return json(result, { headers: { "Cache-Control": "no-store" } });
});
