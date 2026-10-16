import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { listDocuments } from "@/server/documents/service";
import { KnowledgeSearch } from "./KnowledgeSearch";

export default async function KnowledgePage() {
  const user = await requirePageUser("documents:manage_own");
  const docs = await listDocuments(user);
  const searchable = docs.filter((d) => d.chunkCount > 0).length;
  const processing = docs.filter((d) => d.lifecycle === "uploaded" || d.lifecycle === "processing").length;
  return (
    <>
      <PageHeader
        title="Knowledge search"
        description="Search your own documents and profile, or ask a question and get an answer with the exact sources. Only your documents are searched; nothing is invented — if it is not in your documents, you are told so."
      />
      <p className="text-sm text-gray-600">
        {searchable} searchable document{searchable === 1 ? "" : "s"}
        {processing ? ` · ${processing} still being read` : ""} ·{" "}
        <Link href="/dashboard/documents" className="text-brand-700 hover:underline">
          Manage documents
        </Link>
      </p>
      <KnowledgeSearch hasDocuments={searchable > 0} />
    </>
  );
}
