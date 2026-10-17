import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { companionEnabled } from "@/server/companion/planner";
import { revokeFolder } from "@/server/companion/service";
import { json, route } from "@/server/http";

/** Revokes a folder grant. The companion removes it locally at its next heartbeat; folders are only added on the computer. */
export const DELETE = route<{ params: Promise<{ id: string; folderId: string }> }>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  const p = await params;
  return json(await revokeFolder(user, z.uuid().parse(p.id), z.uuid().parse(p.folderId)));
});
