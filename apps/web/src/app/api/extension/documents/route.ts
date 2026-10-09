import { DOCUMENT_TYPE_LABELS, type DocumentType } from "@ufa/shared";
import { requireUser } from "@/server/auth/session";
import { listAttachableDocuments } from "@/server/documents/service";
import { json, route } from "@/server/http";

/** The user's own documents that can be attached to a website's upload field (metadata only). */
export const GET = route(async () => {
  const user = await requireUser("documents:manage_own");
  const docs = await listAttachableDocuments(user);
  return json(
    { documents: docs.map((d) => ({ ...d, typeLabel: DOCUMENT_TYPE_LABELS[d.documentType as DocumentType]?.en ?? d.documentType })) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
