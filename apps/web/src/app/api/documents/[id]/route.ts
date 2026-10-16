import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { deleteDocument, getDocument, setDocumentCloudAi } from "@/server/documents/service";
import { clientIp, json, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("documents:manage_own");
  const id = z.uuid().parse((await params).id);
  // Contains extracted personal data: never cache.
  return json(await getDocument(user, id), { headers: { "Cache-Control": "no-store" } });
});

/** Per-document cloud AI consent (knowledge base). */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("documents:manage_own");
  const id = z.uuid().parse((await params).id);
  const body = await parseBody(req, z.object({ cloudAiAllowed: z.boolean() }).strict());
  return json(await setDocumentCloudAi(user, id, body.cloudAiAllowed, clientIp(req)));
});

export const DELETE = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("documents:manage_own");
  const id = z.uuid().parse((await params).id);
  return json(await deleteDocument(user, id, clientIp(req)));
});
