import type { NextRequest } from "next/server";
import type { JsonObject } from "@ufa/tasks";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { tasks } from "@/server/tasks/engine";
import { kickTaskRunner } from "@/server/tasks/runner";
import { createTaskSchema, listTasksQuery } from "@/server/tasks/schemas";

/** The signed-in user's tasks, newest first, with a cursor for the next page. */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  const q = listTasksQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
  const before = q.beforeCreatedAt && q.beforeId ? { createdAt: q.beforeCreatedAt, id: q.beforeId } : null;
  return json(await tasks().listTasks(user, { status: q.status ?? null, limit: q.limit, before }), { headers: { "Cache-Control": "no-store" } });
});

/** Creates a task. The same idempotencyKey returns the existing task (200 instead of 201). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("task-create", user.id, 30, 10 * 60_000);
  const body = await parseBody(req, createTaskSchema);
  const { task, created } = await tasks().createTask(user, { ...body, input: body.input as JsonObject });
  if (created) kickTaskRunner();
  const { lease_token: _t, lease_owner: _o, ...view } = task;
  return json({ task: view, created }, { status: created ? 201 : 200 });
});
