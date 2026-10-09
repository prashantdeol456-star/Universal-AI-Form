import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { listDocuments, uploadDocument } from "@/server/documents/service";
import { badRequest, clientIp, json, rateLimit, route } from "@/server/http";

export const GET = route(async () => {
  const user = await requireUser("documents:manage_own");
  return json({ documents: await listDocuments(user) }, { headers: { "Cache-Control": "no-store" } });
});

/** multipart/form-data: file, documentType, title? */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser("documents:manage_own");
  rateLimit("upload", user.id, 30, 60 * 60_000);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest("Expected a multipart form upload");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Choose a file to upload");
  const result = await uploadDocument(
    user,
    { file, documentType: String(form.get("documentType") ?? ""), title: (form.get("title") as string | null) ?? null },
    clientIp(req),
  );
  return json(result, { status: 201 });
});
