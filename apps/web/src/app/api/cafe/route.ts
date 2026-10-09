import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { createCafe, myCafe, updateCafe } from "@/server/cafe/workspace";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";

const cafeSchema = z.object({
  name: z.string().trim().min(2).max(200),
  phone: z.string().max(20).nullish(),
  address: z.string().max(500).nullish(),
  city: z.string().max(100).nullish(),
  state: z.string().max(100).nullish(),
  pincode: z.string().regex(/^\d{6}$/).nullish().or(z.literal("")),
});

/** The café this account belongs to (null if none yet). */
export const GET = route(async () => {
  const user = await requireUser("cafe:sessions_request");
  return json({ cafe: await myCafe(user) });
});

/** Register a café (café owner accounts). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:manage");
  rateLimit("cafe-create", user.id, 5, 60_000);
  return json(await createCafe(user, await parseBody(req, cafeSchema), clientIp(req)), { status: 201 });
});

export const PATCH = route(async (req: NextRequest) => {
  const user = await requireUser("cafe:manage");
  return json(await updateCafe(user, await parseBody(req, cafeSchema)));
});
