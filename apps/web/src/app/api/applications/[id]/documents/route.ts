import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { linkDocuments } from "@/server/applications/history";
import { json, parseBody, rateLimit, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  links: z.array(z.object({ documentId: z.uuid(), label: z.string().max(200).nullish() })).min(1).max(20),
});

/** Records which of your documents were used for this application. */
export const POST = route<Ctx>(async (req: NextRequest, { params }) => {
  const user = await requireUser("applications:manage_own");
  rateLimit("application-docs", user.id, 60, 60_000);
  const id = z.uuid().parse((await params).id);
  const { links } = await parseBody(req, bodySchema);
  return json(await linkDocuments(user, id, links));
});
