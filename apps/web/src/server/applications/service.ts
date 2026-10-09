import "server-only";
import { matchOption } from "@ufa/ai";
import { manualReasonFor, type FieldKind, type FillInstruction, type FillResult, type FillValueType } from "@ufa/form-engine";
import { formatFieldValue, getFieldDef, isCatalogKey } from "@ufa/shared";
import { audit } from "../audit";
import type { CafeContext } from "../cafe/context";
import { asUser, db, decryptValue, encryptValue, type Actor } from "../db";
import { badRequest, forbidden, notFound } from "../http";
import { learnFromFill } from "../learning/service";

/**
 * Applications (spec §31–35). An application is created only when the user
 * confirms the preview in the side panel. The server — not the extension —
 * reads the profile values, so a tampered client cannot make up "profile"
 * data; the confirmed snapshot is stored encrypted and becomes immutable.
 */

export interface ConfirmItem {
  field: {
    id: string;
    signature: string;
    label: string;
    name: string | null;
    kind: FieldKind;
    options: string[];
    manual: string | null;
    section?: string | null;
    language?: "en" | "hi" | "mixed";
  };
  /** "profile": value comes from the user's profile; "manual": typed by the user in the side panel. */
  source: "profile" | "manual";
  profileFieldKey: string | null;
  manualValue?: string | null;
  confidence: number | null;
  /** AI provider that suggested the mapping, if any ("gemini" | "local_ai"). */
  aiProvider: string | null;
}

export interface ConfirmInput {
  url: string;
  domain: string;
  formTitle: string | null;
  pageTitle: string;
  formSignatureId: string | null;
  items: ConfirmItem[];
}

export interface ConfirmResult {
  applicationId: string;
  instructions: FillInstruction[];
}

const NEVER_FILLED = new Set<FieldKind>(["file", "password"]);
const CHOICE_KINDS = new Set<FieldKind>(["select", "radio", "combobox", "checkbox"]);

export async function confirmApplication(actor: Actor, input: ConfirmInput, cafe?: CafeContext): Promise<ConfirmResult> {
  if (!input.items.length) throw badRequest("Nothing selected to fill");
  // Café mode: the application belongs to the customer; saving it needs their "applications" permission.
  if (cafe && !cafe.permissions.includes("applications")) {
    throw forbidden("The customer did not allow saving applications in this session. Ask them for a new code that includes it.");
  }
  const subjectId = cafe?.customerId ?? actor.id;
  const seen = new Set<string>();
  for (const it of input.items) {
    if (seen.has(it.field.id)) throw badRequest("A field was selected twice");
    seen.add(it.field.id);
    // Defence in depth: the extension never offers these, and the server refuses them anyway.
    if (it.field.manual || NEVER_FILLED.has(it.field.kind) || manualReasonFor(it.field.label, it.field.name ?? "")) {
      throw badRequest(`"${it.field.label}" must be filled by you (CAPTCHA, OTP, password or upload)`);
    }
    if (it.source === "profile" && (!it.profileFieldKey || !isCatalogKey(it.profileFieldKey))) throw badRequest("Unknown profile field");
    if (it.source === "manual" && !it.manualValue?.trim()) throw badRequest(`Enter a value for "${it.field.label}"`);
  }

  return asUser(actor, async (tx) => {
    const keys = [...new Set(input.items.filter((i) => i.source === "profile").map((i) => i.profileFieldKey!))];
    const rows = keys.length
      ? await tx<{ field_key: string; value: string; is_encrypted: boolean; verified: boolean }[]>`
          select field_key, value, is_encrypted, verified from profile_fields
           where user_id = ${subjectId} and deleted_at is null and field_key in ${tx(keys)}`
      : [];
    const profile = new Map(rows.map((r) => [r.field_key, { value: r.is_encrypted ? decryptValue(r.value) : r.value, verified: r.verified }]));

    const resolved = input.items.map((it) => {
      let value: string;
      let valueType: FillValueType = "text";
      let verified = false;
      if (it.source === "profile") {
        const pv = profile.get(it.profileFieldKey!);
        if (!pv) throw badRequest(`"${getFieldDef(it.profileFieldKey!)?.label.en ?? it.profileFieldKey}" is ${cafe ? "not shared by the customer or not in their profile" : "not in your profile yet"}`);
        value = pv.value;
        verified = pv.verified;
        valueType = (getFieldDef(it.profileFieldKey!)?.input ?? "text") as FillValueType;
      } else {
        value = it.manualValue!.trim().slice(0, 500);
      }
      const option =
        CHOICE_KINDS.has(it.field.kind) && it.field.options.length
          ? matchOption(it.source === "profile" ? formatFieldValue(it.profileFieldKey!, value) : value, it.field.options)
          : null;
      if (CHOICE_KINDS.has(it.field.kind) && it.field.options.length && !option && !(it.field.kind === "checkbox" && it.field.options.length <= 1)) {
        throw badRequest(`"${it.field.label}": your value is not one of the choices`);
      }
      return { it, value, valueType, verified, option };
    });

    const [app] = await tx<{ id: string }[]>`
      insert into applications (customer_id, operator_id, cafe_id, cafe_session_id, website_url, domain, form_name, form_signature_id, status)
      values (${subjectId}, ${cafe ? actor.id : null}, ${cafe?.cafeId ?? null}, ${cafe?.sessionId ?? null},
              ${input.url}, ${input.domain}, ${(input.formTitle ?? input.pageTitle).slice(0, 300) || input.domain},
              ${input.formSignatureId}, 'IN_PROGRESS')
      returning id`;
    for (const [position, r] of resolved.entries()) {
      await tx`
        insert into application_fields (application_id, position, website_field_label, website_field_name, field_type, field_value, is_encrypted,
                                        profile_field_key, source, confidence, ai_provider, verified,
                                        field_ref, field_signature, section, language)
        values (${app!.id}, ${position}, ${r.it.field.label}, ${r.it.field.name}, ${r.it.field.kind}, ${encryptValue(r.option ?? r.value)}, true,
                ${r.it.profileFieldKey}, ${r.it.source}, ${r.it.confidence}, ${r.it.aiProvider}, ${r.verified},
                ${r.it.field.id}, ${r.it.field.signature}, ${r.it.field.section ?? null}, ${r.it.field.language ?? null})`;
    }
    // From here on the snapshot is immutable (0001 trigger), and the row's identity too (0006).
    await tx`update applications set status = 'CONFIRMED', confirmed_at = now() where id = ${app!.id}`;
    await tx`
      insert into application_events (application_id, actor_id, event_type, details)
      values (${app!.id}, ${actor.id}, 'CONFIRMED', ${tx.json({ fields: resolved.length, manual: resolved.filter((r) => r.it.source === "manual").length })})`;
    await audit({
      actorId: actor.id, actorRole: actor.role, action: cafe ? "cafe.form_filled" : "application.confirmed", targetType: "application", targetId: app!.id,
      subjectUserId: subjectId, cafeId: cafe?.cafeId ?? null, metadata: { domain: input.domain, fields: resolved.length },
    }, tx);
    // A saved bookmark for this form is now "recently used".
    if (!cafe) {
      await tx`update saved_forms set last_used_at = now(), form_signature_id = coalesce(form_signature_id, ${input.formSignatureId})
                where user_id = ${actor.id} and url = ${input.url} and deleted_at is null`;
    }

    if (cafe) {
      await db().system`
        insert into notifications (user_id, type, title, body, link)
        values (${cafe.customerId}, 'cafe_form_filled', 'A form was filled for you at a café',
                ${`${input.formTitle ?? input.domain} (${input.domain}). It is saved in your application history.`}, ${`/dashboard/applications/${app!.id}`})`;
    }
    return {
      applicationId: app!.id,
      instructions: resolved.map((r) => ({ fieldId: r.it.field.id, value: r.value, valueType: r.valueType, option: r.option, overwrite: false })),
    };
  });
}

export type FillEvent = { type: "FILLED"; results: FillResult[] } | { type: "UNDONE"; restored: number };

/** What happened on the page (statuses and reasons only — never values), or that the user undid the fill. */
export async function recordFillEvent(actor: Actor, applicationId: string, e: FillEvent) {
  const count = (s: FillResult["status"]) => (e.type === "FILLED" ? e.results.filter((r) => r.status === s).length : 0);
  const details =
    e.type === "FILLED"
      ? { filled: count("filled"), skipped: count("skipped"), failed: count("failed"), results: e.results.map((r) => ({ fieldId: r.fieldId, status: r.status, reason: r.reason ?? null })) }
      : { restored: e.restored };
  await asUser(actor, async (tx) => {
    const [app] = await tx<{ id: string }[]>`select id from applications where id = ${applicationId} and (customer_id = ${actor.id} or operator_id = ${actor.id})`;
    if (!app) throw notFound("Application not found");
    await tx`insert into application_events (application_id, actor_id, event_type, details)
             values (${applicationId}, ${actor.id}, ${e.type}, ${tx.json(details)})`;
  });
  // Filled fields the user confirmed strengthen their mappings (and become learning examples).
  if (e.type === "FILLED") await learnFromFill(actor, applicationId, e.results).catch((err) => console.error(`[learning] ${String(err).slice(0, 200)}`));
  return { saved: true as const };
}

export interface ApplicationUpdate {
  status?: "SUBMITTED" | "CANCELLED";
  applicationNumber?: string | null;
}

/** The user marks the form as submitted by them (we never submit), cancels it, or adds the portal's application number. */
export async function updateApplication(actor: Actor, applicationId: string, u: ApplicationUpdate) {
  return asUser(actor, async (tx) => {
    const [app] = await tx<{ status: string; customer_id: string }[]>`select status, customer_id from applications where id = ${applicationId} and (customer_id = ${actor.id} or operator_id = ${actor.id})`;
    if (!app) throw notFound("Application not found");
    if (u.status && app.status !== "CONFIRMED") throw badRequest(`This application is already ${app.status.toLowerCase()}`);
    const number = u.applicationNumber === undefined ? undefined : u.applicationNumber?.trim().slice(0, 100) || null;
    if (u.status === "SUBMITTED") {
      await tx`update applications set status = 'SUBMITTED', submitted_at = now(), completed_at = now(),
                 application_number = coalesce(${number ?? null}, application_number) where id = ${applicationId}`;
      await audit({ actorId: actor.id, actorRole: actor.role, action: "application.submitted", targetType: "application", targetId: applicationId, subjectUserId: app.customer_id }, tx);
    } else if (u.status === "CANCELLED") {
      await tx`update applications set status = 'CANCELLED', completed_at = now() where id = ${applicationId}`;
    } else if (number !== undefined) {
      await tx`update applications set application_number = ${number} where id = ${applicationId}`;
    }
    await tx`insert into application_events (application_id, actor_id, event_type, details)
             values (${applicationId}, ${actor.id}, ${u.status ?? "UPDATED"}, ${tx.json({ applicationNumberSet: Boolean(number) })})`;
    const [row] = await tx<{ status: string; application_number: string | null }[]>`select status, application_number from applications where id = ${applicationId}`;
    return { id: applicationId, status: row!.status, applicationNumber: row!.application_number };
  });
}
