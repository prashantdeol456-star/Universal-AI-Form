import type { NextRequest } from "next/server";
import type { JsonObject } from "@ufa/tasks";
import { z } from "zod";
import { companionEnabled } from "@/server/companion/planner";
import { deviceReportSchema } from "@/server/companion/schemas";
import { reportLocalStep, requireDevice } from "@/server/companion/service";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { kickTaskRunner } from "@/server/tasks/runner";

/** Progress or outcome of a claimed local step; refused without the current lease or for another device's task. */
export const POST = route<{ params: Promise<{ taskId: string; stepId: string }> }>(async (req: NextRequest, { params }) => {
  const auth = await requireDevice(req);
  companionEnabled();
  rateLimit("companion-report", auth.device.id, 300, 60_000);
  const p = await params;
  const taskId = z.uuid().parse(p.taskId);
  const stepId = z.uuid().parse(p.stepId);
  const body = await parseBody(req, deviceReportSchema);
  const r = await reportLocalStep(auth, taskId, stepId, { ...body, result: (body.result ?? null) as JsonObject | null });
  if (body.outcome === "completed") kickTaskRunner();
  // While the emergency stop is on, the companion must abort what it is doing.
  return json({ ...r, stop: auth.device.stop_requested_at !== null });
});
