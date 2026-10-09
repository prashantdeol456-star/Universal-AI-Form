import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { getProfile } from "@/server/profile/service";

export const GET = route(async () => {
  const user = await requireUser("profile:read_own");
  return json(await getProfile(user));
});
