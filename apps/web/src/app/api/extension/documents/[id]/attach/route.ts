import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { readDocumentForAttach } from "@/server/documents/service";
import { clientIp, parseBody, rateLimit, route } from "@/server/http";

const bodySchema = z.object({ domain: z.string().trim().min(1).max(253).regex(/^[a-z0-9.-]+$/i) });

/** The user clicked "Attach" for an upload field: returns their own file for the extension to put into that field. */
export const POST = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const user = await requireUser("documents:manage_own");
  rateLimit("doc-attach", user.id, 30, 10 * 60_000);
  const id = z.uuid().parse((await params).id);
  const { domain } = await parseBody(req, bodySchema);
  const { data, mime, filename } = await readDocumentForAttach(user, id, domain.toLowerCase(), clientIp(req));
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(data.length),
      "X-File-Name": encodeURIComponent(filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});
