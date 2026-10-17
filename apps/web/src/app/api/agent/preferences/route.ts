import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { deletePreference, listPreferences, PREFERENCE_KEYS, setPreference } from "@/server/companion/memory";
import { companionEnabled } from "@/server/companion/planner";
import { preferenceDeleteQuery, preferenceSchema } from "@/server/companion/schemas";
import { json, parseBody, rateLimit, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  companionEnabled();
  return json({ preferences: await listPreferences(user), keys: PREFERENCE_KEYS }, { headers: { "Cache-Control": "no-store" } });
});

/** Saves one remembered preference. The dashboard calls this only after the user confirmed it. */
export const PUT = route(async (req: NextRequest) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("agent-preference", user.id, 60, 10 * 60_000);
  const { key, value, source } = await parseBody(req, preferenceSchema);
  return json(await setPreference(user, key, value, source));
});

export const DELETE = route(async (req: NextRequest) => {
  const user = await requireUser();
  companionEnabled();
  const { key } = preferenceDeleteQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
  return json(await deletePreference(user, key));
});
