import type { NextRequest } from "next/server";
import { createCustomFieldSchema } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, route } from "@/server/http";
import { createCustomField } from "@/server/profile/service";

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  const input = await parseBody(req, createCustomFieldSchema);
  return json(await createCustomField(user, input, clientIp(req)), { status: 201 });
});
