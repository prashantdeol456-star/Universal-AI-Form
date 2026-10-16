import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { clientIp, json, parseBody, rateLimit, route } from "@/server/http";
import { addJobSchema, searchSchema } from "@/server/jobs/schemas";
import { addJob, searchJobs } from "@/server/jobs/service";

/** The user's job listings with filters and pagination. */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("jobs-search", user.id, 120, 60_000);
  const filters = searchSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return json(await searchJobs(user, filters), { headers: { "Cache-Control": "no-store" } });
});

/** Adds one job by URL (Greenhouse/Lever read through their public APIs; other sites with the details the user gives). */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  rateLimit("jobs-add", user.id, 30, 60_000);
  const body = await parseBody(req, addJobSchema);
  return json(await addJob(user, body, clientIp(req)), { status: 201 });
});
