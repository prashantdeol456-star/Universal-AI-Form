import { createHash } from "node:crypto";
import type { Sql } from "./client";

/**
 * Permanently erases one account and everything it owns (right to erasure).
 * Runs with the owner/system connection. Returns the document storage keys so
 * the caller can delete the files after the transaction committed.
 *
 * Order matters: confirmed application snapshots are immutable unless erasure is
 * explicitly allowed for this transaction; document links (ON DELETE RESTRICT)
 * go first; cafés the user owned (already closed) are removed before the user.
 * Audit entries keep only a short one-way reference.
 */
export async function eraseUser(sql: Sql, userId: string): Promise<{ storageKeys: string[] }> {
  const storageKeys = (await sql<{ storage_key: string }[]>`select storage_key from documents where user_id = ${userId}`).map((r) => r.storage_key);
  await sql.begin(async (tx) => {
    await tx`select set_config('app.allow_snapshot_delete', 'on', true)`;
    await tx`delete from application_documents where application_id in (select id from applications where customer_id = ${userId})`;
    await tx`delete from application_documents where document_id in (select id from documents where user_id = ${userId})`;
    await tx`delete from cafes where owner_id = ${userId}`;
    await tx`delete from users where id = ${userId}`;
    await tx`insert into audit_logs (action, target_type, metadata)
             values ('privacy.account_deleted', 'user', ${tx.json({ ref: createHash("sha256").update(userId).digest("hex").slice(0, 12) })})`;
  });
  return { storageKeys };
}
