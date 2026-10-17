import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { companionEnabled } from "@/server/companion/planner";
import { stopSchema } from "@/server/companion/schemas";
import { clearStop, stopDevices } from "@/server/companion/service";
import { json, parseBody, route } from "@/server/http";

/** Emergency stop for one device, or clearing it (paused tasks stay paused until the user resumes them). */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser();
  companionEnabled();
  const id = z.uuid().parse((await params).id);
  const { action } = await parseBody(req, stopSchema);
  return json(action === "stop" ? await stopDevices(user, id) : await clearStop(user, id));
});
