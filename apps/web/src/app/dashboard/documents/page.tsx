import { requirePageUser } from "@/server/auth/session";
import { listConflicts, listDocuments } from "@/server/documents/service";
import { env } from "@/server/env";
import { ConflictResolver } from "./ConflictResolver";
import { DocumentsManager } from "./DocumentsManager";

export default async function DocumentsPage() {
  const user = await requirePageUser("documents:manage_own");
  const [documents, conflicts] = await Promise.all([listDocuments(user), listConflicts(user)]);
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Documents</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          Upload your documents once. We read them, suggest profile values, and you confirm each one — nothing is saved to
          your profile without your approval. Files are encrypted on the server.
        </p>
      </div>
      {conflicts.length > 0 && (
        <section className="space-y-3" aria-label="Values that need your decision">
          <h2 className="text-sm font-semibold text-gray-900">Needs your decision ({conflicts.length})</h2>
          {conflicts.map((c) => (
            <ConflictResolver key={c.id} conflict={c} />
          ))}
        </section>
      )}
      <DocumentsManager documents={documents} maxUploadMb={env().MAX_UPLOAD_MB} />
    </>
  );
}
