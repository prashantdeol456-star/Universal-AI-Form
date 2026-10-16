import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, route } from "@/server/http";
import { preferencesSchema } from "@/server/jobs/schemas";
import { getPreferences, savePreferences } from "@/server/jobs/service";

export const GET = route(async () => {
  const user = await requireUser();
  return json(await getPreferences(user), { headers: { "Cache-Control": "no-store" } });
});

/** Every preference is optional; fit scores are recomputed. */
export const PUT = route(async (req: NextRequest) => {
  const user = await requireUser();
  return json(await savePreferences(user, await parseBody(req, preferencesSchema)));
});
