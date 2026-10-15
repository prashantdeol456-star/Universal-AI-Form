/** Human-readable names for statuses and audit actions shown in the dashboard. */

export type Tone = "gray" | "green" | "amber" | "red" | "blue";

export const APPLICATION_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  CONFIRMED: { label: "Filled · not submitted", tone: "amber", hint: "Filled with the extension. Submit it on the website, then mark it submitted." },
  SUBMITTED: { label: "Submitted", tone: "green", hint: "You submitted this form on the website." },
  CANCELLED: { label: "Undone", tone: "gray", hint: "The fill was undone or cancelled." },
  FAILED: { label: "Failed", tone: "red", hint: "The website rejected the application." },
  ARCHIVED: { label: "Archived", tone: "gray", hint: "Kept for your records." },
  IN_PROGRESS: { label: "Incomplete", tone: "gray", hint: "Started but never confirmed." },
  DRAFT: { label: "Draft", tone: "gray", hint: "Not confirmed yet." },
};

export const statusMeta = (s: string) => APPLICATION_STATUS[s] ?? { label: s, tone: "gray" as Tone, hint: "" };

const ACTIONS: Record<string, string> = {
  "auth.signup": "Account created",
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in attempt",
  "auth.logout": "Signed out",
  "auth.email_verified": "Email verified",
  "auth.password_changed": "Password changed",
  "auth.password_reset": "Password reset",
  "auth.password_reset_requested": "Password reset requested",
  "auth.session_revoked": "A session was signed out",
  "application.confirmed": "Form filled (you confirmed the values)",
  "application.submitted": "Application marked as submitted",
  "application.documents_linked": "Documents linked to an application",
  "application.values_revealed": "Application values viewed",
  "saved_form.created": "Form saved",
  "admin.created_via_cli": "Administrator created (server CLI)",
  "admin.user_suspend": "Account suspended by an administrator",
  "admin.user_reactivate": "Account reactivated by an administrator",
  "admin.user_revoke_sessions": "Signed out everywhere by an administrator",
  "admin.user_set_role": "Role changed by an administrator",
  "admin.cafe_suspended": "Café suspended by an administrator",
  "admin.cafe_reactivated": "Café reactivated by an administrator",
  "admin.examples_approved": "Learning examples approved",
  "admin.examples_rejected": "Learning examples rejected",
  "admin.pattern_disabled": "Shared pattern disabled",
  "admin.pattern_verified": "Shared pattern verified",
  "ml.model_promoted": "Model promoted",
  "ml.model_staged": "Model moved to staging",
  "ml.model_rolled_back": "Model rolled back",
  "ml.model_disabled": "Model disabled",
  "cafe.created": "Café registered",
  "cafe.operator_invited": "Operator invited",
  "cafe.operator_enabled": "Operator enabled",
  "cafe.operator_disabled": "Operator disabled",
  "cafe.access_requested": "asked to access your details",
  "cafe.code_redeemed": "used your one-time code",
  "cafe.code_created": "Café code created",
  "cafe.session_approved": "You allowed café access",
  "cafe.session_rejected": "You rejected a café request",
  "cafe.session_revoked": "You stopped café access",
  "cafe.session_ended": "ended the session",
  "cafe.profile_used": "used your details to match a form",
  "cafe.form_filled": "filled a form for you",
  "learning.mapping_forgotten": "A learned field mapping was forgotten",
  "learning.contribution_enabled": "Sharing anonymised patterns turned on",
  "learning.contribution_disabled": "Sharing anonymised patterns turned off",
  "learning.contributions_withdrawn": "Contributions withdrawn",
  "privacy.cloud_ai_enabled": "Cloud AI turned on",
  "privacy.cloud_ai_disabled": "Cloud AI turned off",
  "saved_form.deleted": "Saved form removed",
  "document.uploaded": "Document uploaded",
  "document.attached_to_page": "Document attached to a website by the extension",
  "document.processed": "Document read (OCR)",
  "document.deleted": "Document deleted",
  "document.extraction_confirmed": "Document value confirmed",
  "document.extraction_rejected": "Document value rejected",
  "document.accessed_by_cafe": "Document opened by a café operator",
  "profile.field_created": "Profile field added",
  "profile.field_updated": "Profile field updated",
  "profile.field_deleted": "Profile field removed",
  "profile.field_verified": "Profile field verified",
  "profile.custom_field_created": "Custom field added",
  "profile.conflict_resolved": "Profile conflict resolved",
  "profile.sensitive_revealed": "Sensitive value viewed",
  "privacy.data_exported": "Data exported",
  "privacy.deletion_requested": "Account deletion scheduled",
  "site.authorized": "Allowed the assistant on a website",
  "site.revoked": "Removed the assistant's access to a website",
  "privacy.ai_profile_sharing_on": "Allowed AI to use your professional profile for answers",
  "privacy.ai_profile_sharing_off": "Stopped AI from using your professional profile",
  "agent.answer_saved": "Answer saved by the assistant",
  "privacy.deletion_cancelled": "Account deletion cancelled",
  "privacy.account_deleted": "An account was permanently deleted",
  "auth.mfa_enabled": "Two-step verification turned on",
  "auth.mfa_disabled": "Two-step verification turned off",
  "auth.mfa_verified": "Signed in with two-step verification",
  "auth.mfa_failed": "Wrong two-step verification code",
  "cafe.closed": "Café closed",
  "security.malware_detected": "Upload blocked (malware)",
  "security.upload_rejected": "Upload rejected",
};

export const actionLabel = (a: string) => ACTIONS[a] ?? a.replace(/[._]/g, " ");

export const formatDateTime = (iso: string | Date | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

export const formatDate = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium" }) : "—");

/** "5 min ago", "yesterday", or a date. */
export function timeAgo(iso: string | Date): string {
  const d = new Date(iso).getTime();
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return formatDate(iso);
}
