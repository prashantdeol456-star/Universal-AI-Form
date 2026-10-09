import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { confirmExtraction, rejectExtraction } from "@/server/documents/service";
import { clientIp, json, parseBody, route } from "@/server/http";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), value: z.string().max(2000).optional() }),
  z.object({ action: z.literal("reject") }),
]);

/** Review one extracted value: confirm (optionally edited) into the profile, or reject it. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser("profile:write_own");
  const id = z.uuid().parse((await params).id);
  const body = await parseBody(req, bodySchema);
  if (body.action === "reject") {
    await rejectExtraction(user, id, clientIp(req));
    return json({ status: "rejected" });
  }
  const result = await confirmExtraction(user, id, body.value, clientIp(req));
  return json(result, { status: result.status === "conflict" ? 409 : 200 });
});
