import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { json, parseBody, rateLimit, route } from "@/server/http";
import { recordMappingFeedback } from "@/server/mapping/service";

const bodySchema = z.object({
  domain: z.string().min(1).max(255),
  field: z.object({
    signature: z.string().regex(/^[0-9a-f]{8}$/),
    label: z.string().min(1).max(200),
    language: z.enum(["en", "hi", "mixed"]),
    section: z.string().max(200).nullish(),
    kind: z.string().max(30).nullish(),
    options: z.array(z.string().max(200)).max(50).optional(),
  }),
  suggestedKey: z.string().max(120).nullable(),
  correctKey: z.string().min(1).max(120),
  provider: z.string().max(40).nullish(),
});

/** ✓ / ✗ on a suggested mapping in the side panel. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("profile:write_own");
  rateLimit("mapping-feedback", user.id, 120, 60_000);
  return json(await recordMappingFeedback(user, await parseBody(req, bodySchema)));
});
