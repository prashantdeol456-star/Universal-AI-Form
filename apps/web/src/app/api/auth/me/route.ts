import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";

export const GET = route(async () => {
  const u = await requireUser();
  return json({ user: { id: u.id, email: u.email, fullName: u.fullName, role: u.role, emailVerified: u.emailVerified } });
});
