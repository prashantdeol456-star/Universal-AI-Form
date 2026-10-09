import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { getDocument, listConflicts } from "@/server/documents/service";
import { HttpError } from "@/server/http";
import { DocumentReview } from "./DocumentReview";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser("documents:manage_own");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  try {
    const [doc, conflicts] = await Promise.all([getDocument(user, id), listConflicts(user)]);
    const keys = new Set(doc.extractions.map((e) => e.fieldKey));
    return <DocumentReview doc={doc} conflicts={conflicts.filter((c) => keys.has(c.fieldKey))} />;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
}
