import type { NextRequest } from "next/server";
import { z } from "zod";
import { reviewGroup } from "@/server/admin/learning";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({
  normalizedLabel: z.string().min(1).max(200),
  key: z.string().min(1).max(120),
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(300).nullish(),
});

/** Approve / reject all pending examples of one label → key pair. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("admin:learning_manage");
  rateLimit("admin-review", user.id, 300, 60_000);
  return json(await reviewGroup(user, await parseBody(req, bodySchema), clientIp(req)));
});
