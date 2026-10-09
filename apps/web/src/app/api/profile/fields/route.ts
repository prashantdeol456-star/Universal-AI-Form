import type { NextRequest } from "next/server";
import { fieldKeySchema, updateProfileFieldSchema } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { clientIp, conflict, json, parseBody, route } from "@/server/http";
import { deleteField, updateField } from "@/server/profile/service";

export const PUT = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  const input = await parseBody(req, updateProfileFieldSchema);
  const result = await updateField(user, input, { source: "user_input", userConfirmed: true, ip: clientIp(req) });
  if (result.status === "conflict") {
    // The client must ask the user and resend with confirmOverwrite: true.
    throw conflict(`You currently have "${result.currentValue}" saved and verified. Replace it?`, result);
  }
  return json(result);
});

export const DELETE = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  const key = fieldKeySchema.parse(req.nextUrl.searchParams.get("key"));
  await deleteField(user, key, clientIp(req));
  return json({ ok: true });
});
