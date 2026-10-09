import type { NextRequest } from "next/server";
import { fieldKeySchema } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { fieldHistory } from "@/server/profile/service";

export const GET = route(async (req: NextRequest) => {
  const user = await requireUser("profile:read_own");
  const key = fieldKeySchema.parse(req.nextUrl.searchParams.get("key"));
  return json({ history: await fieldHistory(user, key) });
});
