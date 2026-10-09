import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { setOperatorStatus } from "@/server/cafe/workspace";
import { clientIp, json, parseBody, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) });

/** Disable (ends their sessions immediately) or re-enable an operator. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("cafe:operators_manage");
  const { status } = await parseBody(req, bodySchema);
  return json(await setOperatorStatus(user, z.uuid().parse((await params).id), status, clientIp(req)));
});
