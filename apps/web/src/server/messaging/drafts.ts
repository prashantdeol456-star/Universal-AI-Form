import "server-only";
import { buildReplyMime, createDraft, draftExists } from "@ufa/messaging";
import type { TransactionSql } from "@ufa/db";
import { audit } from "../audit";
import { asUser, decryptValue, type Actor } from "../db";
import { HttpError, notFound } from "../http";
import { assertCanDraft, gmailConfig, gmailHttp, gmailHttpError, gmailSession } from "./gmail";
import { draftContentSha, recipientsOf, recipientsSha } from "./intelligence";

/**
 * Gmail draft creation (Phase 5). Two separate moments:
 *  1. approval (inside the task engine's approval transaction, no network): the draft's
 *     current subject + body + recipients are frozen by hash; recipients must equal the ones
 *     the approval request showed;
 *  2. creation (a non-repeatable task step): exactly the frozen content is created as a
 *     Gmail DRAFT. A draft id already recorded is never created twice; if the step's outcome
 *     is unknown (crash after Google answered), the task pauses for the user to check Gmail.
 * Nothing is ever sent.
 */
interface Row {
  id: string;
  status: string;
  channel: string;
  thread_ref: string;
  recipients_encrypted: string | null;
  subject_encrypted: string | null;
  body_encrypted: string;
  approved_content_sha: string | null;
  gmail_draft_id: string | null;
}

export async function approveDraftInTx(tx: TransactionSql, userId: string, draftId: string, expectedRecipientsSha: string): Promise<{ approved: true; contentSha: string }> {
  const [r] = await tx<Row[]>`select * from message_drafts where id = ${draftId} and user_id = ${userId} for update`;
  if (!r || r.channel !== "gmail") throw new Error("Draft not found");
  if (r.status !== "draft") throw new Error("This draft was already approved or closed");
  const rec = recipientsOf(r);
  if (recipientsSha(rec.to) !== expectedRecipientsSha) throw new Error("The recipients changed after the approval was requested");
  const contentSha = draftContentSha(r.subject_encrypted ? decryptValue(r.subject_encrypted) : null, decryptValue(r.body_encrypted), rec.to);
  await tx`update message_drafts set status = 'approved', approved_content_sha = ${contentSha}, approved_at = now() where id = ${draftId}`;
  return { approved: true, contentSha };
}

export async function createApprovedGmailDraft(actor: Actor, draftId: string): Promise<{ gmailDraftId: string; reused: boolean }> {
  const [r] = await asUser(actor, (tx) => tx<Row[]>`select * from message_drafts where id = ${draftId} and user_id = ${actor.id}`);
  if (!r || r.channel !== "gmail") throw notFound("Draft not found");
  const session = await gmailSession(actor);
  const cfg = gmailConfig();
  // Already created: do not create a second one.
  if (r.gmail_draft_id) {
    const still = await draftExists(gmailHttp(), cfg.endpoints, session.token, r.gmail_draft_id).catch(() => true);
    if (still) return { gmailDraftId: r.gmail_draft_id, reused: true };
    throw new HttpError(409, "draft_deleted_in_gmail", "This draft was created before and has since been deleted in Gmail; it is not created again automatically");
  }
  if (r.status !== "approved") throw new HttpError(409, "not_approved", "Approve the draft first");
  assertCanDraft(session);
  const rec = recipientsOf(r);
  const subject = r.subject_encrypted ? decryptValue(r.subject_encrypted) : "";
  const body = decryptValue(r.body_encrypted);
  if (draftContentSha(subject, body, rec.to) !== r.approved_content_sha) throw new HttpError(409, "content_changed", "The draft changed after approval; it was not created");
  let created;
  try {
    created = await createDraft(gmailHttp(), cfg.endpoints, session.token, buildReplyMime({ to: rec.to, subject, body, inReplyTo: rec.inReplyTo, references: rec.references }), r.thread_ref);
  } catch (err) {
    const e = gmailHttpError(err);
    await asUser(actor, (tx) => tx`update message_drafts set error = ${e.message.slice(0, 300)} where id = ${draftId}`);
    throw e;
  }
  await asUser(actor, async (tx) => {
    await tx`update message_drafts set status = 'created', gmail_draft_id = ${created.draftId}, error = null where id = ${draftId}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "gmail.draft_created", targetType: "message_draft", targetId: draftId, subjectUserId: actor.id }, tx);
  });
  return { gmailDraftId: created.draftId, reused: false };
}
