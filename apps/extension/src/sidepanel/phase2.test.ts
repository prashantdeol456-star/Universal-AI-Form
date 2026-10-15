import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FormSnapshot, NormalizedField } from "@ufa/form-engine";
import type { FieldMappingView, MapResult } from "./api";

// The side panel talks to the server and to Chrome; both are replaced here.
const api = vi.hoisted(() => ({
  listSitePermissions: vi.fn(),
  grantSitePermission: vi.fn(),
  revokeSitePermission: vi.fn(),
  createFillTask: vi.fn(),
  claimBrowserStep: vi.fn(),
  reportBrowserStep: vi.fn(),
  confirmApplication: vi.fn(),
  sendFillEvent: vi.fn(),
}));
const page = vi.hoisted(() => ({ analyzeTab: vi.fn(), fillTab: vi.fn(), verifyTab: vi.fn() }));
vi.mock("./api", () => api);
vi.mock("./page", () => page);

const { plannedItems, sourceText } = await import("./Fill");
const { decide, authorizeSite, forgetSiteCache } = await import("./siteAccess");
const { fillViaTask } = await import("./fillTask");

let n = 0;
function field(label: string, extra: Partial<NormalizedField> = {}): NormalizedField {
  n++;
  return {
    id: `f${n}`, kind: "text", label, labelSource: "label", name: null, htmlId: null, placeholder: null, section: null, required: true, options: [],
    autocomplete: null, inputMode: null, maxLength: null, pattern: null, hint: null, language: "en", visible: true, disabled: false, readOnly: false,
    hasValue: false, manual: null, accept: null, signature: "00000000", frame: "top", inShadowDom: false, ...extra,
  };
}
function mapped(f: NormalizedField, key: string, value: string, extra: Partial<FieldMappingView> = {}): FieldMappingView {
  return {
    fieldId: f.id, profileFieldKey: key, profileFieldLabel: key, profileFieldLabelHi: null, value, valueVerified: true, optionMatch: null, confidence: 0.93,
    decision: "AUTO_FILL", reason: "high_confidence" as never, sources: ["rules"] as never, candidates: [], savedAnswer: null, ...extra,
  };
}

describe("preview: source, confidence and editable values", () => {
  const name = field("Full name");
  const city = field("City");
  const snap = { url: "https://jobs.example.com/apply", fields: [name, city], formSignature: "sig1" } as unknown as FormSnapshot;
  const map = { formSignatureId: "fs1", fields: [mapped(name, "full_name", "Asha Verma"), mapped(city, "city", "Noida", { valueVerified: false, sources: ["gemini"] as never, confidence: 0.71 })] } as unknown as MapResult;

  it("says where each value comes from and how sure the match is", () => {
    const items = plannedItems(snap, map, {});
    expect(items.map((i) => i.display)).toEqual(["Asha Verma", "Noida"]);
    expect(sourceText(items[0]!)).toMatch(/verified in your profile.*matched by its label.*93%/);
    expect(sourceText(items[1]!)).toMatch(/not verified.*AI match, please check.*71%/);
  });

  it("uses the user's own value for this form instead of the profile value", () => {
    const items = plannedItems(snap, map, { [city.id]: { include: true, manualValue: "Gurugram", overwrite: false, override: true } });
    const c = items.find((i) => i.field.id === city.id)!;
    expect(c).toMatchObject({ source: "manual", display: "Gurugram" });
    expect(sourceText(c)).toMatch(/replaces your profile value/);
  });

  it("keeps the profile value while the replacement is still empty", () => {
    const items = plannedItems(snap, map, { [city.id]: { include: true, manualValue: "  ", overwrite: false, override: true } });
    expect(items.find((i) => i.field.id === city.id)).toMatchObject({ source: "profile", display: "Noida" });
  });

  it("never plans OTP, CAPTCHA, password or payment fields even with a value", () => {
    const otp = field("OTP", { manual: "otp" });
    const card = field("Card number", { manual: "payment" });
    const pw = field("Password", { kind: "password" });
    const s = { fields: [otp, card, pw] } as unknown as FormSnapshot;
    const m = { formSignatureId: null, fields: [mapped(otp, "x", "1"), mapped(card, "y", "2"), mapped(pw, "z", "3")] } as unknown as MapResult;
    expect(plannedItems(s, m, {})).toEqual([]);
  });
});

describe("site access in the panel", () => {
  beforeEach(() => {
    forgetSiteCache();
    vi.clearAllMocks();
    vi.stubGlobal("chrome", { permissions: { request: vi.fn(async () => true), remove: vi.fn(async () => true) } });
  });

  it("denies a site the user has not allowed, and allows only the granted scopes", async () => {
    api.listSitePermissions.mockResolvedValue([{ id: "s1", origin: "https://jobs.example.com", scopes: ["inspect", "fill"] }]);
    expect(await decide("fill", "https://jobs.example.com/apply")).toEqual({ allowed: true });
    expect(await decide("attach_file", "https://jobs.example.com/apply")).toMatchObject({ allowed: false, fix: "authorize_site" });
    expect(await decide("inspect", "https://evil.example.net/")).toMatchObject({ allowed: false, fix: "authorize_site" });
    // Subdomains are other sites.
    expect(await decide("inspect", "https://www.jobs.example.com/")).toMatchObject({ allowed: false });
  });

  it("never allows submitting, Next, payments or messages, whatever was granted", async () => {
    api.listSitePermissions.mockResolvedValue([{ id: "s1", origin: "https://jobs.example.com", scopes: ["inspect", "fill", "attach_file", "insert_text"] }]);
    for (const a of ["submit", "click_next", "pay", "send_message", "solve_captcha", "enter_otp", "enter_password", "create_account"] as const) {
      expect(await decide(a, "https://jobs.example.com/apply")).toMatchObject({ allowed: false, fix: "never" });
    }
  });

  it("refuses non-web pages and tabs Chrome did not share", async () => {
    api.listSitePermissions.mockResolvedValue([]);
    expect(await decide("inspect", null)).toMatchObject({ allowed: false, fix: "invalid_url" });
    expect(await decide("inspect", "chrome://settings")).toMatchObject({ allowed: false, fix: "invalid_url" });
    expect(await decide("fill", "http://jobs.example.com/")).toMatchObject({ allowed: false, fix: "invalid_url" });
  });

  it("asks Chrome for this one origin before telling the server", async () => {
    api.grantSitePermission.mockResolvedValue({});
    const r = await authorizeSite("https://jobs.example.com/apply?x=1", ["inspect", "fill"]);
    expect(r).toEqual({ ok: true });
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ["https://jobs.example.com/*"] });
    expect(api.grantSitePermission).toHaveBeenCalledWith("https://jobs.example.com/apply?x=1", ["inspect", "fill"]);
  });

  it("does not record a grant when the user declines Chrome's prompt", async () => {
    (chrome.permissions.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const r = await authorizeSite("https://jobs.example.com/", ["inspect"]);
    expect(r.ok).toBe(false);
    expect(api.grantSitePermission).not.toHaveBeenCalled();
  });

  it("refuses javascript: and data: links without prompting", async () => {
    expect((await authorizeSite("javascript:alert(1)", ["inspect"])).ok).toBe(false);
    expect((await authorizeSite("data:text/html,hi", ["inspect"])).ok).toBe(false);
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });
});

describe("fillViaTask", () => {
  const name = field("Full name");
  const snap = { url: "https://jobs.example.com/apply", domain: "jobs.example.com", formTitle: null, pageTitle: "Apply", formSignature: "sig1", fields: [name] } as unknown as FormSnapshot;
  const map = { formSignatureId: "fs1", fields: [mapped(name, "full_name", "Asha Verma")] } as unknown as MapResult;
  const claim = (type: string, id: string) => ({ task: { id: "t1" }, step: { id, step_type: type, title: type, input_json: { page: 1 } }, leaseToken: `lease-${id}` });

  beforeEach(() => {
    vi.clearAllMocks();
    api.createFillTask.mockResolvedValue({ task: { id: "t1", status: "queued" } });
    api.claimBrowserStep.mockResolvedValueOnce(claim("browser.read_page", "s1")).mockResolvedValueOnce(claim("browser.fill_fields", "s2"));
    api.reportBrowserStep.mockResolvedValue({});
    api.confirmApplication.mockResolvedValue({ applicationId: "a1", instructions: [{ fieldId: name.id, action: "type", value: "Asha Verma" }] });
    api.sendFillEvent.mockResolvedValue({});
  });

  it("checkpoints the page, fills only approved items and verifies each one", async () => {
    page.analyzeTab.mockResolvedValue({ ok: true, snapshot: snap });
    page.fillTab.mockResolvedValue({ ok: true, results: [{ fieldId: name.id, status: "filled" }] });
    page.verifyTab.mockResolvedValue({ ok: true, results: [{ fieldId: name.id, status: "verified" }] });
    const items = plannedItems(snap, map, {});
    const out = await fillViaTask({ tabId: 7, snapshot: snap, mapping: map, items, idempotencyKey: "k1" });

    expect(out).toMatchObject({ taskId: "t1", applicationId: "a1", verification: { [name.id]: "verified" }, pageChanged: false });
    // Claims are scoped to this task only.
    expect(api.claimBrowserStep).toHaveBeenCalledWith(expect.any(String), "t1");
    const [read, fill] = api.reportBrowserStep.mock.calls;
    expect(read![2]).toMatchObject({ outcome: "completed", checkpoint: { page: 1, url: snap.url, formSignature: "sig1" } });
    expect(fill![2]).toMatchObject({ outcome: "completed", result: { filled: 1, verified: 1 } });
    // The fill never overwrites what the user typed unless they chose to.
    expect(page.fillTab.mock.calls[0]![1][0].instruction.overwrite).toBe(false);
  });

  it("stops before typing anything when the page changed after the review", async () => {
    page.analyzeTab.mockResolvedValue({ ok: true, snapshot: { ...snap, formSignature: "other" } });
    await expect(fillViaTask({ tabId: 7, snapshot: snap, mapping: map, items: plannedItems(snap, map, {}), idempotencyKey: "k2" })).rejects.toThrow(/page changed/);
    expect(page.fillTab).not.toHaveBeenCalled();
    expect(api.confirmApplication).not.toHaveBeenCalled();
    expect(api.reportBrowserStep.mock.calls[1]![2]).toMatchObject({ outcome: "failed" });
  });

  it("reports an uncertain step (task pauses) when filled fields vanish", async () => {
    page.analyzeTab.mockResolvedValue({ ok: true, snapshot: snap });
    page.fillTab.mockResolvedValue({ ok: true, results: [{ fieldId: name.id, status: "filled" }] });
    page.verifyTab.mockResolvedValue({ ok: true, results: [{ fieldId: name.id, status: "missing" }] });
    const out = await fillViaTask({ tabId: 7, snapshot: snap, mapping: map, items: plannedItems(snap, map, {}), idempotencyKey: "k3" });
    expect(out.pageChanged).toBe(true);
    expect(api.reportBrowserStep.mock.calls[1]![2]).toMatchObject({ outcome: "uncertain" });
  });
});
