import type { NextRequest } from "next/server";
import { formSnapshotSchema, type FormSnapshot } from "@ufa/form-engine";
import { requireUser } from "@/server/auth/session";
import { recordFormSignature } from "@/server/forms/service";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { assertSiteAllowed } from "@/server/sites/service";

/** Called by the extension after it reads a form: records the form structure (no values). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("form-analyze", user.id, 120, 60_000);
  const snapshot = (await parseBody(req, formSnapshotSchema)) as FormSnapshot;
  await assertSiteAllowed(user, snapshot.url, "inspect");
  return json(await recordFormSignature(snapshot));
});
