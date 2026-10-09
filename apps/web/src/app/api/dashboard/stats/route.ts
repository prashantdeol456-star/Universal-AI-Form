import { requireUser } from "@/server/auth/session";
import { getDashboardStats } from "@/server/dashboard";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  return json(await getDashboardStats(user));
});
