import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { requireUser } from "@/server/auth/session";
import { asUser } from "@/server/db";
import { clientIp, json, parseBody, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  const [p] = await asUser(user, (tx) => tx<{ cloud_ai_enabled: boolean }[]>`select cloud_ai_enabled from profiles where user_id = ${user.id}`);
  return json({ cloudAiEnabled: p?.cloud_ai_enabled ?? true });
});

const bodySchema = z.object({ cloudAiEnabled: z.boolean() });

export const PATCH = route(async (req: NextRequest) => {
  const user = await requireUser();
  const { cloudAiEnabled } = await parseBody(req, bodySchema);
  await asUser(user, async (tx) => {
    await tx`update profiles set cloud_ai_enabled = ${cloudAiEnabled} where user_id = ${user.id}`;
    await audit({ actorId: user.id, actorRole: user.role, action: cloudAiEnabled ? "privacy.cloud_ai_enabled" : "privacy.cloud_ai_disabled", targetType: "user", targetId: user.id, subjectUserId: user.id, ip: clientIp(req) }, tx);
  });
  return json({ cloudAiEnabled });
});
