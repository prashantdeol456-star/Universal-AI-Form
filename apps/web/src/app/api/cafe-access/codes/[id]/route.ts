import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { cancelAccessCode } from "@/server/cafe/customer";
import { json, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser("privacy:manage_own");
  return json(await cancelAccessCode(user, z.uuid().parse((await params).id)));
});
