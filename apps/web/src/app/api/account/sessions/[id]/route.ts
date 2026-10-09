import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { requireUser } from "@/server/auth/session";
import { asUser } from "@/server/db";
import { json, notFound, route } from "@/server/http";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  const id = z.uuid().parse((await params).id);
  await asUser(user, async (tx) => {
    // RLS limits this to the caller's own sessions.
    const rows = await tx`update auth_sessions set revoked_at = now() where id = ${id} and revoked_at is null returning id`;
    if (rows.length === 0) throw notFound("Session not found");
    await audit({ actorId: user.id, actorRole: user.role, action: "auth.session_revoked", targetType: "session", targetId: id, subjectUserId: user.id }, tx);
  });
  return json({ ok: true });
});
