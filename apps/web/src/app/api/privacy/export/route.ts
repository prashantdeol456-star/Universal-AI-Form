import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { clientIp, rateLimit, route } from "@/server/http";
import { exportUserData } from "@/server/privacy";

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser("privacy:manage_own");
  rateLimit("export", user.id, 5, 60 * 60_000);
  const data = await exportUserData(user, clientIp(req));
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
