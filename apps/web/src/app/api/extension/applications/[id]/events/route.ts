import type { NextRequest } from "next/server";
import { z } from "zod";
import { MAX_FIELDS } from "@ufa/form-engine";
import { requireUser } from "@/server/auth/session";
import { recordFillEvent } from "@/server/applications/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const reason = z.enum([
  "manual_field", "not_fillable", "no_option", "too_long", "pattern_mismatch", "invalid_email", "invalid_number", "invalid_date",
  "not_found", "hidden", "disabled", "has_value", "rejected_by_page", "option_not_found", "error",
]);

const bodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("FILLED"),
    results: z.array(z.object({ fieldId: z.string().max(40), status: z.enum(["filled", "skipped", "failed"]), reason: reason.optional() })).max(MAX_FIELDS),
  }),
  z.object({ type: z.literal("UNDONE"), restored: z.number().int().min(0).max(MAX_FIELDS) }),
]);

/** Outcome of filling on the page (statuses only, no values), or an undo. */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("applications:manage_own");
  rateLimit("application-events", user.id, 60, 60_000);
  const id = z.uuid().parse((await params).id);
  return json(await recordFillEvent(user, id, await parseBody(req, bodySchema)));
});
