import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { reprocessDocument } from "@/server/documents/service";
import { requeueDocument } from "@/server/documents/worker";
import { json, rateLimit, route } from "@/server/http";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("documents:manage_own");
  rateLimit("reprocess", user.id, 20, 60 * 60_000);
  const id = z.uuid().parse((await params).id);
  await reprocessDocument(user, id, requeueDocument);
  return json({ ok: true });
});
