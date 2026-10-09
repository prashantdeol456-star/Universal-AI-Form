import "server-only";
import { audit } from "./audit";
import { asUser, decryptValue, type Actor } from "./db";

/**
 * Full machine-readable export of the user's own data (JSON). Sensitive values
 * are decrypted because the export goes to the data owner; the export itself is audited.
 */
export async function exportUserData(actor: Actor, ip?: string) {
  return asUser(actor, async (tx) => {
    const [user] = await tx`select id, email, full_name, mobile, role, email_verified_at, created_at from users where id = ${actor.id}`;
    const fields = await tx<{ field_key: string; value: string; is_encrypted: boolean; source: string; verified: boolean; confidence: string | null; created_at: Date; updated_at: Date; last_verified_at: Date | null }[]>`
      select field_key, value, is_encrypted, source, verified, confidence, created_at, updated_at, last_verified_at
        from profile_fields where user_id = ${actor.id} and deleted_at is null order by field_key`;
    const customFields = await tx`select field_key, label, data_type, options, is_sensitive, created_at from profile_custom_fields where user_id = ${actor.id} and deleted_at is null`;
    const documents = await tx`select id, document_type, title, original_filename, mime_type, size_bytes, status, created_at from documents where user_id = ${actor.id} and deleted_at is null`;
    const applications = await tx`select id, website_url, domain, organization, form_name, form_type, application_number, status, started_at, confirmed_at, submitted_at from applications where customer_id = ${actor.id}`;
    const applicationFields = await tx<{ application_id: string; website_field_label: string; field_value: string | null; is_encrypted: boolean; profile_field_key: string | null; source: string | null; created_at: Date }[]>`
      select f.application_id, f.website_field_label, f.field_value, f.is_encrypted, f.profile_field_key, f.source, f.created_at
        from application_fields f join applications a on a.id = f.application_id
       where a.customer_id = ${actor.id} order by f.created_at, f.position`;
    const learnedMappings = await tx`
      select domain, field_label, profile_field_key, verified, success_count, failure_count, verification_source, created_at, updated_at
        from form_mappings where scope = 'USER' and user_id = ${actor.id} order by updated_at desc`;
    const learningExamples = await tx`
      select source, domain, field_label, field_context, profile_field_key, status, created_at
        from learning_examples where contributor_user_id = ${actor.id} order by created_at desc limit 5000`;
    const sessions = await tx`select client_type, user_agent, ip_address, created_at, last_seen_at, expires_at, revoked_at from auth_sessions where user_id = ${actor.id}`;
    const accessHistory = await tx`select actor_id, actor_role, action, target_type, target_id, cafe_id, created_at from audit_logs where subject_user_id = ${actor.id} order by created_at desc limit 5000`;
    const cafeSessions = await tx`select cafe_id, operator_id, purpose, status, approved_at, expires_at, revoked_at, created_at from cafe_sessions where customer_id = ${actor.id}`;

    await audit({ actorId: actor.id, actorRole: actor.role, action: "privacy.data_exported", targetType: "user", targetId: actor.id, subjectUserId: actor.id, ip }, tx);

    return {
      exportedAt: new Date().toISOString(),
      format: "universal-ai-form-assistant/export@1",
      user,
      profile: fields.map((f) => ({
        fieldKey: f.field_key,
        value: f.is_encrypted ? decryptValue(f.value) : f.value,
        source: f.source,
        verified: f.verified,
        confidence: f.confidence === null ? null : Number(f.confidence),
        createdAt: f.created_at,
        updatedAt: f.updated_at,
        lastVerifiedAt: f.last_verified_at,
      })),
      customFields,
      documents,
      applications,
      applicationFields: applicationFields.map((f) => ({
        applicationId: f.application_id,
        websiteFieldLabel: f.website_field_label,
        value: f.field_value === null ? null : f.is_encrypted ? decryptValue(f.field_value) : f.field_value,
        profileFieldKey: f.profile_field_key,
        source: f.source,
        createdAt: f.created_at,
      })),
      learning: { mappings: learnedMappings, contributedExamples: learningExamples },
      sessions,
      cafeSessions,
      accessHistory,
    };
  });
}
