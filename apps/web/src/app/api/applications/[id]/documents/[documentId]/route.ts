import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { unlinkDocument } from "@/server/applications/history";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string; documentId: string }> };

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("applications:manage_own");
  const p = await params;
  return json(await unlinkDocument(user, z.uuid().parse(p.id), z.uuid().parse(p.documentId)));
});
