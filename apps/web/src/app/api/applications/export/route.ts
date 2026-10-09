import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { exportHistoryCsv } from "@/server/applications/history";
import { rateLimit, route } from "@/server/http";

const BOM = String.fromCharCode(0xfeff);

/** History as CSV (form, website, status, numbers, dates — no field values). */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser("applications:manage_own");
  rateLimit("history-export", user.id, 10, 60_000);
  const p = req.nextUrl.searchParams;
  const csv = await exportHistoryCsv(user, {
    q: p.get("q") ?? undefined,
    status: p.get("status") ?? undefined,
    from: p.get("from") ?? undefined,
    to: p.get("to") ?? undefined,
  });
  // BOM so Excel opens Hindi text correctly.
  return new Response(BOM + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="application-history-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
