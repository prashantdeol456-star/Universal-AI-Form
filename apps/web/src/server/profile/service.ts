import "server-only";
import { computeCompletion, decideFieldUpdate } from "@ufa/profile-engine";
import {
  getFieldDef,
  isCustomKey,
  maskValue,
  toCustomKey,
  validateValue,
  type CreateCustomFieldInput,
  type ProfileFieldDef,
  type ProfileFieldSource,
  type UpdateProfileFieldInput,
} from "@ufa/shared";
import type { TransactionSql } from "@ufa/db";
import { audit } from "../audit";
import { asUser, decryptValue, encryptValue, type Actor } from "../db";
import { badRequest, conflict, notFound } from "../http";
import type { CustomFieldDefView, HistoryEntry, ProfileFieldView, ProfileView } from "./types";

export type { CustomFieldDefView, HistoryEntry, ProfileFieldView, ProfileView };

interface FieldRow {
  id: string;
  field_key: string;
  value: string;
  is_encrypted: boolean;
  source: ProfileFieldSource;
  verified: boolean;
  confidence: string | null;
  updated_at: Date;
  last_verified_at: Date | null;
  source_document_id: string | null;
}

interface CustomRow {
  field_key: string;
  label: string;
  data_type: string;
  options: string[];
  is_sensitive: boolean;
}

/** Effective definition for catalog or custom keys. */
async function resolveDef(tx: TransactionSql, key: string): Promise<{ def: ProfileFieldDef | null; custom: CustomRow | null }> {
  const def = getFieldDef(key);
  if (def) return { def, custom: null };
  if (!isCustomKey(key)) return { def: null, custom: null };
  const [custom] = await tx<CustomRow[]>`
    select field_key, label, data_type, options, is_sensitive from profile_custom_fields
     where field_key = ${key} and deleted_at is null`;
  return { def: null, custom: custom ?? null };
}

function plain(row: Pick<FieldRow, "value" | "is_encrypted">): string {
  return row.is_encrypted ? decryptValue(row.value) : row.value;
}

function isSensitive(def: ProfileFieldDef | null, custom: CustomRow | null): boolean {
  return def ? def.sensitivity !== "normal" : Boolean(custom?.is_sensitive);
}

function validate(key: string, raw: string, def: ProfileFieldDef | null, custom: CustomRow | null): string {
  if (def) {
    const r = validateValue(def.validator, raw, { options: def.options });
    if (!r.ok) throw badRequest(r.error, { fieldKey: key });
    return r.value;
  }
  if (custom) {
    const validator =
      custom.data_type === "number" ? "number" :
      custom.data_type === "date" ? "date" :
      custom.data_type === "boolean" ? "yes_no" :
      custom.data_type === "select" ? "select" : "text";
    const r = validateValue(validator, raw, { options: custom.options });
    if (!r.ok) throw badRequest(r.error, { fieldKey: key });
    return r.value;
  }
  throw badRequest("Unknown profile field", { fieldKey: key });
}

export async function getProfile(actor: Actor): Promise<ProfileView> {
  return asUser(actor, async (tx) => {
    const rows = await tx<FieldRow[]>`
      select id, field_key, value, is_encrypted, source, verified, confidence, updated_at, last_verified_at, source_document_id
        from profile_fields where user_id = ${actor.id} and deleted_at is null order by field_key`;
    const customs = await tx<CustomRow[]>`
      select field_key, label, data_type, options, is_sensitive from profile_custom_fields
       where user_id = ${actor.id} and deleted_at is null order by created_at`;
    const [{ n }] = (await tx`select count(*)::int as n from document_conflicts where user_id = ${actor.id} and status = 'OPEN'`) as unknown as [{ n: number }];
    const customByKey = new Map(customs.map((c) => [c.field_key, c]));

    const fields = rows.map<ProfileFieldView>((r) => {
      const sensitive = isSensitive(getFieldDef(r.field_key) ?? null, customByKey.get(r.field_key) ?? null);
      const value = plain(r);
      return {
        fieldKey: r.field_key,
        value: sensitive ? maskValue(value) : value,
        masked: sensitive,
        source: r.source,
        verified: r.verified,
        confidence: r.confidence === null ? null : Number(r.confidence),
        updatedAt: r.updated_at.toISOString(),
        lastVerifiedAt: r.last_verified_at?.toISOString() ?? null,
        sourceDocumentId: r.source_document_id,
      };
    });

    return {
      fields,
      customFields: customs.map((c) => ({ fieldKey: c.field_key, label: c.label, dataType: c.data_type, options: c.options, isSensitive: c.is_sensitive })),
      openConflicts: n,
      completion: computeCompletion(rows.map((r) => ({ fieldKey: r.field_key, verified: r.verified }))),
    };
  });
}

export type UpdateResult =
  | { status: "created" | "updated" | "verified" | "unchanged"; fieldKey: string }
  | { status: "conflict"; fieldKey: string; currentValue: string; reason: string };

export interface UpdateOptions {
  source?: ProfileFieldSource;
  userConfirmed?: boolean;
  confidence?: number | null;
  sourceDocumentId?: string | null;
  sourceChatMessageId?: string | null;
  reason?: string;
  ip?: string;
}

/**
 * Single entry point for writing a profile value. Manual edits from the profile
 * page are user-confirmed; later phases (documents, chat, applications) call
 * this with their own source and confirmation state.
 */
export async function updateField(actor: Actor, input: UpdateProfileFieldInput, opts: UpdateOptions = {}): Promise<UpdateResult> {
  return asUser(actor, (tx) => updateFieldTx(tx, actor, input, opts));
}

/** Same as updateField, inside a caller-provided RLS transaction (so related writes commit atomically). */
export async function updateFieldTx(tx: TransactionSql, actor: Actor, input: UpdateProfileFieldInput, opts: UpdateOptions = {}): Promise<UpdateResult> {
  const source = opts.source ?? "user_input";
  const userConfirmed = opts.userConfirmed ?? true;

  const { def, custom } = await resolveDef(tx, input.fieldKey);
  const value = validate(input.fieldKey, input.value, def, custom);
  const sensitive = isSensitive(def, custom);

  const [existing] = await tx<FieldRow[]>`
    select id, field_key, value, is_encrypted, source, verified, confidence, updated_at, last_verified_at, source_document_id
      from profile_fields where user_id = ${actor.id} and field_key = ${input.fieldKey} and deleted_at is null
     for update`;
  const existingPlain = existing ? plain(existing) : null;

  const decision = decideFieldUpdate(
    existing ? { value: existingPlain!, source: existing.source, verified: existing.verified, confidence: existing.confidence === null ? null : Number(existing.confidence) } : null,
    { value, source, userConfirmed, confirmOverwrite: input.confirmOverwrite, confidence: opts.confidence ?? (userConfirmed ? 1 : null) },
  );

  const stored = sensitive ? encryptValue(value) : value;
  const confidence = opts.confidence ?? (userConfirmed ? 1 : null);
  const historyBase = { user_id: actor.id, field_key: input.fieldKey, is_encrypted: sensitive, changed_by: actor.id, change_reason: opts.reason ?? null };

  switch (decision.action) {
    case "NOOP":
      return { status: "unchanged", fieldKey: input.fieldKey };

    case "CONFLICT":
      return {
        status: "conflict",
        fieldKey: input.fieldKey,
        currentValue: sensitive ? maskValue(existingPlain!) : existingPlain!,
        reason: decision.reason,
      };

    case "VERIFY": {
      await tx`update profile_fields set verified = true, last_verified_at = now(), updated_by = ${actor.id} where id = ${existing!.id}`;
      await tx`insert into profile_field_history ${tx({ ...historyBase, profile_field_id: existing!.id, old_value: existing!.value, new_value: existing!.value, is_encrypted: existing!.is_encrypted, old_source: existing!.source, new_source: source, change_type: "VERIFY" })}`;
      await audit({ actorId: actor.id, actorRole: actor.role, action: "profile.field_verified", targetType: "profile_field", targetId: input.fieldKey, subjectUserId: actor.id, ip: opts.ip }, tx);
      return { status: "verified", fieldKey: input.fieldKey };
    }

    case "CREATE": {
      const [row] = await tx<{ id: string }[]>`
        insert into profile_fields (user_id, field_key, value, is_encrypted, source, verified, confidence,
                                    source_document_id, source_chat_message_id, updated_by, last_verified_at)
        values (${actor.id}, ${input.fieldKey}, ${stored}, ${sensitive}, ${source}, ${decision.verified}, ${confidence},
                ${opts.sourceDocumentId ?? null}, ${opts.sourceChatMessageId ?? null}, ${actor.id},
                ${decision.verified ? new Date() : null})
        returning id`;
      await tx`insert into profile_field_history ${tx({ ...historyBase, profile_field_id: row!.id, old_value: null, new_value: stored, old_source: null, new_source: source, change_type: "CREATE" })}`;
      await audit({ actorId: actor.id, actorRole: actor.role, action: "profile.field_created", targetType: "profile_field", targetId: input.fieldKey, subjectUserId: actor.id, ip: opts.ip, metadata: { source } }, tx);
      return { status: "created", fieldKey: input.fieldKey };
    }

    case "UPDATE": {
      await tx`
        update profile_fields
           set value = ${stored}, is_encrypted = ${sensitive}, source = ${source}, verified = ${decision.verified},
               confidence = ${confidence}, source_document_id = ${opts.sourceDocumentId ?? null},
               source_chat_message_id = ${opts.sourceChatMessageId ?? null}, updated_by = ${actor.id},
               last_verified_at = ${decision.verified ? new Date() : existing!.last_verified_at}
         where id = ${existing!.id}`;
      // History keeps the old value exactly as stored (still encrypted if it was).
      await tx`insert into profile_field_history ${tx({ ...historyBase, profile_field_id: existing!.id, old_value: existing!.value, new_value: stored, old_source: existing!.source, new_source: source, change_type: "UPDATE" })}`;
      await audit({ actorId: actor.id, actorRole: actor.role, action: "profile.field_updated", targetType: "profile_field", targetId: input.fieldKey, subjectUserId: actor.id, ip: opts.ip, metadata: { source, overwroteVerified: existing!.verified } }, tx);
      return { status: "updated", fieldKey: input.fieldKey };
    }
  }
}

export async function deleteField(actor: Actor, fieldKey: string, ip?: string): Promise<void> {
  await asUser(actor, async (tx) => {
    const [row] = await tx<FieldRow[]>`
      update profile_fields set deleted_at = now(), updated_by = ${actor.id}
       where user_id = ${actor.id} and field_key = ${fieldKey} and deleted_at is null
       returning id, field_key, value, is_encrypted, source, verified, confidence, updated_at, last_verified_at, source_document_id`;
    if (!row) throw notFound("Field not found");
    await tx`insert into profile_field_history (profile_field_id, user_id, field_key, old_value, new_value, is_encrypted, old_source, change_type, changed_by)
             values (${row.id}, ${actor.id}, ${fieldKey}, ${row.value}, null, ${row.is_encrypted}, ${row.source}, 'DELETE', ${actor.id})`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "profile.field_deleted", targetType: "profile_field", targetId: fieldKey, subjectUserId: actor.id, ip }, tx);
  });
}

/** Returns the decrypted value of a sensitive field to its owner, and audits the reveal. */
export async function revealField(actor: Actor, fieldKey: string, ip?: string): Promise<string> {
  return asUser(actor, async (tx) => {
    const [row] = await tx<FieldRow[]>`
      select id, field_key, value, is_encrypted, source, verified, confidence, updated_at, last_verified_at, source_document_id
        from profile_fields where user_id = ${actor.id} and field_key = ${fieldKey} and deleted_at is null`;
    if (!row) throw notFound("Field not found");
    if (row.is_encrypted) {
      await audit({ actorId: actor.id, actorRole: actor.role, action: "profile.sensitive_revealed", targetType: "profile_field", targetId: fieldKey, subjectUserId: actor.id, ip }, tx);
    }
    return plain(row);
  });
}

export async function fieldHistory(actor: Actor, fieldKey: string): Promise<HistoryEntry[]> {
  return asUser(actor, async (tx) => {
    const rows = await tx<{ change_type: string; old_value: string | null; new_value: string | null; is_encrypted: boolean; old_source: string | null; new_source: string | null; change_reason: string | null; created_at: Date }[]>`
      select change_type, old_value, new_value, is_encrypted, old_source, new_source, change_reason, created_at
        from profile_field_history where user_id = ${actor.id} and field_key = ${fieldKey}
       order by created_at desc limit 50`;
    const show = (v: string | null, enc: boolean) => (v === null ? null : enc ? maskValue(decryptValue(v)) : v);
    return rows.map((r) => ({
      changeType: r.change_type,
      oldValue: show(r.old_value, r.is_encrypted && r.old_value?.startsWith("enc:") === true),
      newValue: show(r.new_value, r.is_encrypted && r.new_value?.startsWith("enc:") === true),
      oldSource: r.old_source,
      newSource: r.new_source,
      reason: r.change_reason,
      createdAt: r.created_at.toISOString(),
    }));
  });
}

export async function createCustomField(actor: Actor, input: CreateCustomFieldInput, ip?: string): Promise<{ fieldKey: string }> {
  if (input.dataType === "select" && input.options.length === 0) throw badRequest("A select field needs at least one option");
  const fieldKey = toCustomKey(input.label);
  await asUser(actor, async (tx) => {
    const [dup] = await tx`select 1 from profile_custom_fields where user_id = ${actor.id} and field_key = ${fieldKey} and deleted_at is null`;
    if (dup) throw conflict("A custom field with a similar name already exists");
    await tx`insert into profile_custom_fields (user_id, field_key, label, data_type, options, is_sensitive)
             values (${actor.id}, ${fieldKey}, ${input.label}, ${input.dataType}, ${tx.json(input.options)}, ${input.isSensitive})`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "profile.custom_field_created", targetType: "profile_custom_field", targetId: fieldKey, subjectUserId: actor.id, ip }, tx);
  });
  if (input.value) await updateField(actor, { fieldKey, value: input.value, confirmOverwrite: false }, { ip });
  return { fieldKey };
}
