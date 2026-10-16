import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";
import { retrieve } from "@/server/knowledge/retrieval";

const query = z.object({ q: z.string().min(1).max(300), limit: z.coerce.number().int().min(1).max(8).optional() });

/** Searches the signed-in user's own documents and profile. Excerpts contain personal data: never cached. */
export const GET = route(async (req: NextRequest) => {
  const user = await requireUser("documents:manage_own");
  rateLimit("knowledge-search", user.id, 60, 60_000);
  const { q, limit } = query.parse({ q: req.nextUrl.searchParams.get("q") ?? "", limit: req.nextUrl.searchParams.get("limit") ?? undefined });
  return json(await retrieve(user, q, { limit }), { headers: { "Cache-Control": "no-store" } });
});
