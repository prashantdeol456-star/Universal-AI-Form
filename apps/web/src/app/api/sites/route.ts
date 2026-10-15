import type { NextRequest } from "next/server";
import { SITE_SCOPES } from "@ufa/form-engine";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";
import { grantSite, listSitePermissions } from "@/server/sites/service";

/** Sites the signed-in user has allowed the assistant to work on. */
export const GET = route(async () => {
  const user = await requireUser();
  return json({ sites: await listSitePermissions(user) }, { headers: { "Cache-Control": "no-store" } });
});

const bodySchema = z.object({ url: z.string().max(2048), scopes: z.array(z.enum(SITE_SCOPES)).min(1).max(4) });

/** Allows scopes on the origin of `url`. Submitting, paying or sending can never be allowed. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("site-grant", user.id, 60, 10 * 60_000);
  const { url, scopes } = await parseBody(req, bodySchema);
  return json({ site: await grantSite(user, url, scopes, clientIp(req)) }, { status: 201 });
});
