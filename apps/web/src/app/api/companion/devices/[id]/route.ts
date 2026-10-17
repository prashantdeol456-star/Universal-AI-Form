import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { companionEnabled } from "@/server/companion/planner";
import { devicePatchSchema } from "@/server/companion/schemas";
import { revokeDevice, updateDevice } from "@/server/companion/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** Name, capabilities and AI consents of a device. Only implemented capabilities can be granted. */
export const PATCH = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("companion-device", user.id, 60, 60_000);
  const id = z.uuid().parse((await params).id);
  return json(await updateDevice(user, id, await parseBody(req, devicePatchSchema)));
});

/** Revokes the device for good (its token stops working) and cancels its unfinished tasks. */
export const DELETE = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  const id = z.uuid().parse((await params).id);
  return json(await revokeDevice(user, id));
});
