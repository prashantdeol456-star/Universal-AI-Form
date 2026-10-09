import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { deleteDocument, getDocument } from "@/server/documents/service";
import { clientIp, json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("documents:manage_own");
  const id = z.uuid().parse((await params).id);
  // Contains extracted personal data: never cache.
  return json(await getDocument(user, id), { headers: { "Cache-Control": "no-store" } });
});

export const DELETE = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("documents:manage_own");
  const id = z.uuid().parse((await params).id);
  return json(await deleteDocument(user, id, clientIp(req)));
});
