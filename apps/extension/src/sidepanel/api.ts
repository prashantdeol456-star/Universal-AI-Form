import type { FillInstruction, FillResult, FormSnapshot, NormalizedField } from "@ufa/form-engine";
import { clearSession, getServerUrl, getSession, originPattern, saveSession } from "./storage";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const server = await getServerUrl();
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth !== false) {
    const s = await getSession();
    if (!s) throw new ApiError(401, "Please sign in");
    headers.Authorization = `Bearer ${s.token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "omit", // bearer token only; never the website's cookies
    });
  } catch {
    throw new ApiError(0, `Cannot reach the server at ${server}. Check the server address in Settings.`);
  }
  const payload = await res.json().catch(() => null);
  if (res.status === 401 && init.auth !== false) await clearSession();
  if (!res.ok) throw new ApiError(res.status, payload?.error?.message ?? `Request failed (${res.status})`, payload?.error?.code);
  return payload as T;
}

export interface Me {
  id: string;
  email: string;
  fullName: string;
  role: string;
  emailVerified: boolean;
}

/**
 * Asks Chrome for permission to talk to the server (needed once per server;
 * must run inside a click handler).
 */
export async function ensureServerPermission(): Promise<boolean> {
  const origins = [originPattern(await getServerUrl())];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

/** Step 1. Returns an MFA challenge when the account uses two-step verification. */
export async function login(email: string, password: string, remember: boolean): Promise<{ mfaToken: string } | null> {
  const r = await request<{ token?: string; expiresAt?: string; mfaRequired?: boolean; mfaToken?: string }>("/api/auth/login", {
    body: { email, password, client: "extension" },
    auth: false,
  });
  if (r.mfaRequired && r.mfaToken) return { mfaToken: r.mfaToken };
  await saveSession({ token: r.token!, expiresAt: r.expiresAt! }, remember);
  return null;
}

/** Step 2: authenticator (or recovery) code. */
export async function loginMfa(mfaToken: string, code: string, remember: boolean): Promise<void> {
  const r = await request<{ token: string; expiresAt: string }>("/api/auth/login/mfa", { body: { mfaToken, code, client: "extension" }, auth: false });
  await saveSession({ token: r.token, expiresAt: r.expiresAt }, remember);
}

export async function logout(): Promise<void> {
  try {
    await request("/api/auth/logout", { method: "POST" });
  } finally {
    await clearSession();
  }
}

export const me = () => request<{ user: Me }>("/api/auth/me").then((r) => r.user);

export type Decision = "AUTO_FILL" | "USER_REVIEW" | "ASK_USER" | "GEMINI" | "MANUAL";

export interface FieldMappingView {
  fieldId: string;
  profileFieldKey: string | null;
  profileFieldLabel: string | null;
  profileFieldLabelHi: string | null;
  value: string | null;
  valueVerified: boolean;
  optionMatch: string | null;
  confidence: number;
  decision: Decision;
  reason: string;
  sources: string[];
  candidates: Array<{ fieldKey: string; label: string; confidence: number }>;
  /** The user answered this exact question before. */
  savedAnswer: string | null;
  /** Where the value comes from in the user's own records (knowledge base). Absent in café mode. */
  evidence?: FieldEvidence | null;
}

export interface FieldEvidence {
  status: "verified" | "unverified" | "conflicting" | "unconfirmed_document" | "missing";
  origin: string | null;
  document: { id: string; title: string } | null;
  /** Found in a document, not confirmed yet (masked with • when sensitive). */
  suggestion: { value: string; documentId: string; documentTitle: string } | null;
}

export interface MapResult {
  formSignatureId: string;
  previousApplications: Array<{ id: string; status: string; applicationNumber: string | null; createdAt: string; submittedAt: string | null }>;
  savedForm: { id: string; name: string } | null;
  formChange: { added: number; removed: number; lastAppliedAt: string } | null;
  cafe: { sessionId: string; customerName: string; expiresAt: string; permissions: string[] } | null;
  seenBefore: boolean;
  firstSeenAt: string;
  fields: FieldMappingView[];
  stats: { fields: number; matched: number; autoFill: number; review: number; askUser: number; manual: number; missingValues: number; averageConfidence: number | null };
  engine: {
    localAi: boolean;
    semantic: boolean;
    gemini: "off" | "not_needed" | "used" | "cached" | "limit_reached" | "failed";
    geminiFields: number;
    geminiAsked: number;
    cloudAiAllowed: boolean;
  };
}

/** Maps the form to your profile — or, in café mode, to the customer's (sends labels/types only). */
export const mapForm = (snapshot: FormSnapshot, cafeSessionId?: string | null) =>
  request<MapResult>(`/api/extension/forms/map${cafeSessionId ? `?cafeSession=${encodeURIComponent(cafeSessionId)}` : ""}`, { body: snapshot });

export interface CafeSessionOption {
  id: string;
  customerName: string;
  purpose: string | null;
  permissions: string[];
  expiresAt: string;
}

/** Café accounts: the café and the customers this operator may fill for right now. */
export const getCafe = () =>
  request<{ cafe: { id: string; name: string; myRole: "OWNER" | "OPERATOR" } | null; sessions: CafeSessionOption[] }>("/api/extension/cafe");

/** Operator enters the customer's one-time code. */
export const redeemCafeCode = (code: string) =>
  request<{ sessionId: string; customerName: string; expiresAt: string }>("/api/cafe/sessions/redeem", { body: { code } });

export const sendMappingFeedback = (body: {
  domain: string;
  field: { signature: string; label: string; language: "en" | "hi" | "mixed"; section?: string | null; kind?: string; options?: string[] };
  suggestedKey: string | null;
  correctKey: string;
  provider?: string | null;
}) => request<{ saved: true }>("/api/extension/mappings/feedback", { body });

export interface ConfirmItem {
  field: Pick<NormalizedField, "id" | "signature" | "label" | "name" | "kind" | "options" | "manual" | "section" | "language">;
  source: "profile" | "manual";
  profileFieldKey: string | null;
  manualValue?: string | null;
  confidence: number | null;
  aiProvider: "gemini" | "local_ai" | null;
}

/** The user confirmed the preview: the server stores the snapshot and returns the values to fill. */
export const confirmApplication = (body: {
  url: string;
  domain: string;
  formTitle: string | null;
  pageTitle: string;
  formSignatureId: string | null;
  items: ConfirmItem[];
  cafeSessionId?: string | null;
}) => request<{ applicationId: string; instructions: FillInstruction[] }>("/api/extension/applications", { body });

export const sendFillEvent = (id: string, body: { type: "FILLED"; results: FillResult[] } | { type: "UNDONE"; restored: number }) =>
  request<{ saved: true }>(`/api/extension/applications/${encodeURIComponent(id)}/events`, { body });

/** Bookmarks the page in the user's Saved Forms (idempotent per URL). */
export const saveForm = (body: { name: string; url: string; formSignatureId?: string | null }) =>
  request<{ id: string; created: boolean }>("/api/saved-forms", { body });

export const updateApplication = (id: string, body: { status?: "SUBMITTED" | "CANCELLED"; applicationNumber?: string | null }) =>
  request<{ id: string; status: string; applicationNumber: string | null }>(`/api/extension/applications/${encodeURIComponent(id)}`, { method: "PATCH", body });

export type ComposeTone = "formal" | "friendly";
export type ComposeLanguage = "en" | "hi" | "hinglish";
export interface EmailTemplate {
  subject: string;
  body: string;
}
export interface ComposeResult extends EmailTemplate {
  /** Draft with placeholders (no values): sent back when asking for a change. */
  template: EmailTemplate;
  source: "gemini" | "template";
  notice: string | null;
  used: string[];
  missing: Array<{ key: string; label: string }>;
}

export const composeEmail = (body: { instruction: string; tone: ComposeTone; language: ComposeLanguage; previous?: EmailTemplate | null }) =>
  request<ComposeResult>("/api/extension/compose", { body });

export interface AttachableDocument {
  id: string;
  documentType: string;
  typeLabel: string;
  title: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export const listAttachableDocuments = () => request<{ documents: AttachableDocument[] }>("/api/extension/documents").then((r) => r.documents);

/** Downloads one of the user's own documents for an upload field on `domain` (audited on the server). */
export async function fetchDocumentForAttach(id: string, domain: string): Promise<{ name: string; mime: string; base64: string }> {
  const server = await getServerUrl();
  const s = await getSession();
  if (!s) throw new ApiError(401, "Please sign in");
  const res = await fetch(`${server}/api/extension/documents/${encodeURIComponent(id)}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ domain }),
    credentials: "omit",
  }).catch(() => {
    throw new ApiError(0, `Cannot reach the server at ${server}.`);
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new ApiError(res.status, payload?.error?.message ?? `Request failed (${res.status})`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: decodeURIComponent(res.headers.get("X-File-Name") ?? "document"), mime: res.headers.get("Content-Type") ?? "application/octet-stream", base64: btoa(bin) };
}

// --- Assistant (agent) ---------------------------------------------------------------------

export const assistantMessage = (text: string) =>
  request<{ saved: Array<{ key: string; label: string; value: string; status: string }>; skipped: string[] }>("/api/extension/assistant/message", { body: { text } });

export const assistantAnswer = (body: { question: string; answer: string; profileFieldKey?: string | null; kind?: string | null; domain?: string | null }) =>
  request<{ savedTo: "profile" | "answers" | "none"; label: string; status?: string }>("/api/extension/assistant/answer", { body });

export const assistantDraft = (body: { question: string; role?: string | null }) =>
  request<{ answer: string; missing: string[]; source: "gemini" | "template"; canAskConsent: boolean }>("/api/extension/assistant/draft", { body });

export const setAiProfileSharing = (enabled: boolean) => request<{ enabled: boolean }>("/api/account/ai-sharing", { body: { enabled } });

// --- Tasks (persistent task engine) ---------------------------------------------------------

export type TaskStatus = "queued" | "running" | "waiting_for_browser" | "waiting_for_approval" | "paused" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "skipped" | "cancelled";

export interface TaskSummary {
  id: string;
  title: string;
  task_type: string;
  status: TaskStatus;
  error_message: string | null;
  created_at: string;
  steps_total: number;
  steps_done: number;
}
export interface TaskStepView {
  id: string;
  step_key: string;
  title: string;
  status: StepStatus;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  output: string | null;
}
export interface TaskApprovalView {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  action_summary: string;
  expires_at: string;
}
export interface TaskDetail {
  task: TaskSummary;
  steps: TaskStepView[];
  approvals: TaskApprovalView[];
}
export interface TaskEventView {
  id: string;
  event_type: string;
  message: string;
  created_at: string;
}

export const listTasks = () => request<{ tasks: TaskSummary[] }>("/api/tasks?limit=20");
export const getTaskDetail = (id: string) => request<TaskDetail>(`/api/tasks/${id}`);
export const getTaskEvents = (id: string) => request<{ events: TaskEventView[] }>(`/api/tasks/${id}/events?limit=15`);
export const controlTask = (id: string, body: { action: "pause" | "resume" | "cancel" | "retry"; confirmUncertain?: boolean }) =>
  request<{ status: TaskStatus }>(`/api/tasks/${id}/control`, { body });
export const decideApproval = (id: string, decision: "approve" | "reject") => request(`/api/approvals/${id}`, { body: { decision } });


// --- Site access (Phase 2) ---------------------------------------------------------------------

export interface SitePermission {
  id: string;
  origin: string;
  scopes: Array<"inspect" | "fill" | "attach_file" | "insert_text">;
}
export const listSitePermissions = () => request<{ sites: SitePermission[] }>("/api/sites").then((r) => r.sites);
export const grantSitePermission = (url: string, scopes: SitePermission["scopes"]) => request<{ site: SitePermission }>("/api/sites", { body: { url, scopes } });
export const revokeSitePermission = (id: string) => request(`/api/sites/${id}`, { method: "DELETE" });

// --- Browser steps of fill tasks (Phase 2) ------------------------------------------------------

export interface BrowserClaim {
  task: { id: string; title: string; task_type: string; input_json: Record<string, unknown> };
  step: { id: string; step_key: string; step_type: string; title: string; input_json: Record<string, unknown> };
  leaseToken: string;
}
export const createFillTask = (url: string, idempotencyKey: string) =>
  request<{ task: { id: string; status: TaskStatus } }>("/api/tasks", { body: { taskType: "fill_form", input: { url }, idempotencyKey } });
export const claimBrowserStep = (workerId: string, taskId: string) =>
  request<{ claim: BrowserClaim | null }>("/api/tasks/worker/claim", { body: { workerId, taskId } }).then((r) => r.claim);
export const reportBrowserStep = (
  taskId: string,
  stepId: string,
  body: { leaseToken: string; outcome: "progress" | "completed" | "failed" | "uncertain"; message?: string; result?: Record<string, unknown>; checkpoint?: Record<string, unknown> },
) => request(`/api/tasks/${taskId}/steps/${stepId}/report`, { body });
export const addTaskPage = (taskId: string, url: string) => request<{ status: TaskStatus }>(`/api/tasks/${taskId}/pages`, { body: { url } });
