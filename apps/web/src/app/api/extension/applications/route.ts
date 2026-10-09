import type { NextRequest } from "next/server";
import { z } from "zod";
import { MAX_FIELDS, normalizedFieldSchema } from "@ufa/form-engine";
import { requireUser } from "@/server/auth/session";
import { resolveCafeContext } from "@/server/cafe/context";
import { confirmApplication } from "@/server/applications/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

const field = normalizedFieldSchema.pick({ id: true, signature: true, label: true, name: true, kind: true, options: true, manual: true, section: true, language: true });

const bodySchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  domain: z.string().min(1).max(255),
  formTitle: z.string().max(300).nullable(),
  pageTitle: z.string().max(300),
  formSignatureId: z.uuid().nullable(),
  /** Set when an operator fills for a café customer. */
  cafeSessionId: z.uuid().nullish(),
  items: z
    .array(
      z.object({
        field,
        source: z.enum(["profile", "manual"]),
        profileFieldKey: z.string().max(120).nullable(),
        manualValue: z.string().max(500).nullish(),
        confidence: z.number().min(0).max(1).nullable(),
        aiProvider: z.enum(["gemini", "local_ai"]).nullable(),
      }),
    )
    .min(1)
    .max(MAX_FIELDS),
});

/**
 * The user confirmed the preview: stores the immutable snapshot and returns the
 * values to fill. Contains personal data, so it is never cached.
 */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("applications:manage_own");
  rateLimit("application-confirm", user.id, 30, 60_000);
  const body = await parseBody(req, bodySchema);
  const cafe = body.cafeSessionId ? await resolveCafeContext(user, body.cafeSessionId) : undefined;
  return json(await confirmApplication(user, body, cafe), { status: 201, headers: { "Cache-Control": "no-store" } });
});
