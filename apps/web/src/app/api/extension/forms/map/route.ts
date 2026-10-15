import type { NextRequest } from "next/server";
import { formSnapshotSchema, type FormSnapshot } from "@ufa/form-engine";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { resolveCafeContext } from "@/server/cafe/context";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { mapFormForUser } from "@/server/mapping/service";
import { assertSiteAllowed } from "@/server/sites/service";

/** Maps the fields of a detected form to the user's profile (records the form signature too). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:read_own");
  rateLimit("form-map", user.id, 60, 60_000);
  const snapshot = (await parseBody(req, formSnapshotSchema)) as FormSnapshot;
  // The user must have allowed this site; checked here too, not only in the extension.
  await assertSiteAllowed(user, snapshot.url, "inspect");
  // ?cafeSession=<id>: an operator fills for a café customer (re-checked on every request).
  const sessionParam = req.nextUrl.searchParams.get("cafeSession");
  const cafe = sessionParam ? await resolveCafeContext(user, z.uuid().parse(sessionParam)) : undefined;
  // Contains profile values (masked when sensitive): never cache.
  return json(await mapFormForUser(user, snapshot, cafe), { headers: { "Cache-Control": "no-store" } });
});
