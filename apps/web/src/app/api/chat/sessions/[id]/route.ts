import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { deleteSession, getSession } from "@/server/chat/service";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("chat:use");
  return json(await getSession(user, z.uuid().parse((await params).id)), { headers: { "Cache-Control": "no-store" } });
});

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("chat:use");
  await deleteSession(user, z.uuid().parse((await params).id));
  return json({ ok: true });
});
