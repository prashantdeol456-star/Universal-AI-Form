// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanLabel, fnv1a, humanizeIdentifier, normalizeLabel } from "../text";
import { formSnapshotSchema } from "../schema";
import { detectForm } from "./detect";
import { watchForm } from "./watch";

const TEST_FORM = readFileSync(path.resolve(__dirname, "../../../../apps/test-form/public/index.html"), "utf8");

function load(html: string) {
  document.open();
  // No scripts, frames or external resources in the unit test DOM (the browser test covers those).
  document.write(
    html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<iframe[^>]*><\/iframe>/g, "")
      .replace(/<link[^>]*>/g, "")
      .replace(/<img[^>]*src="\/captcha\.svg"[^>]*>/, '<img alt="captcha image">'),
  );
  document.close();
}

const byName = (snap: ReturnType<typeof detectForm>, name: string) => snap.fields.find((f) => f.name === name);

describe("text helpers", () => {
  it("cleans labels and humanizes identifiers", () => {
    expect(cleanLabel("  Candidate Full Name * : ")).toBe("Candidate Full Name");
    expect(cleanLabel("1. Father's Name (required)")).toBe("Father's Name");
    expect(humanizeIdentifier("txtFatherName")).toBe("father name");
    expect(humanizeIdentifier("ctl00_cph1_txt_dob")).toBe("dob");
    expect(normalizeLabel("Candidate's Father's Full-Name")).toBe("candidates fathers full name");
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("detectForm on the test recruitment form", () => {
  beforeEach(() => load(TEST_FORM));

  it("finds the fields with the right labels, kinds and sections", () => {
    const snap = detectForm(document);
    expect(byName(snap, "candidateName")).toMatchObject({ label: "Candidate Full Name", kind: "text", required: true, section: "Personal Details", labelSource: "label" });
    expect(byName(snap, "fatherName")).toMatchObject({ label: "Father's Name", required: true });
    expect(byName(snap, "dob")).toMatchObject({ kind: "date", hint: "As recorded in your Class 10 certificate" });
    expect(byName(snap, "maritalStatus")).toMatchObject({ kind: "select", options: ["Unmarried", "Married", "Divorced", "Widowed"] });
    expect(snap.formTitle).toMatch(/Staff Recruitment Examination 2026/);
  });

  it("groups radio buttons into one field with the question as label", () => {
    const snap = detectForm(document);
    expect(byName(snap, "gender")).toMatchObject({ kind: "radio", label: "Gender", options: ["Male", "Female", "Transgender"], required: true });
    expect(byName(snap, "exsm")).toMatchObject({ kind: "radio", label: "Are you an Ex-Serviceman?", options: ["Yes", "No"] });
    expect(snap.fields.filter((f) => f.name === "gender")).toHaveLength(1);
  });

  it("reads Hindi labels and marks their language", () => {
    const snap = detectForm(document);
    expect(byName(snap, "pita_naam")).toMatchObject({ label: "पिता का नाम", language: "hi", section: "अन्य विवरण (Other Details)" });
    expect(byName(snap, "sthayi_pata")).toMatchObject({ label: "स्थायी पता", kind: "textarea", required: true });
  });

  it("reads labels from table layouts without <label> elements", () => {
    const snap = detectForm(document);
    expect(byName(snap, "txtMobile")).toMatchObject({ label: "Mobile Number", labelSource: "table", kind: "tel", required: true, maxLength: 10 });
    expect(byName(snap, "txtEmail")).toMatchObject({ label: "Email ID", kind: "email" });
  });

  it("handles ARIA comboboxes with their option list", () => {
    const qual = detectForm(document).fields.find((f) => f.htmlId === "qual");
    expect(qual).toMatchObject({ kind: "combobox", label: "Highest Qualification", labelSource: "aria", options: ["10th", "12th", "Diploma", "Graduation", "Post Graduation"] });
  });

  it("marks hidden fields as not visible", () => {
    expect(byName(detectForm(document), "state")).toMatchObject({ visible: false });
  });

  it("flags CAPTCHA, OTP and file inputs; ignores hidden inputs and buttons", () => {
    const snap = detectForm(document);
    expect(byName(snap, "captchaCode")?.manual).toBe("captcha");
    expect(byName(snap, "otp")?.manual).toBe("otp");
    expect(byName(snap, "photo")).toMatchObject({ kind: "file", accept: ".jpg,.jpeg", manual: null });
    expect(byName(snap, "csrf")).toBeUndefined();
    expect(snap.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["captcha_present", "otp_present"]));
  });

  it("captures no values — only whether a field is filled", () => {
    (document.getElementById("fname") as HTMLInputElement).value = "Secret Value";
    const snap = detectForm(document);
    expect(JSON.stringify(snap)).not.toContain("Secret Value");
    expect(byName(snap, "fatherName")?.hasValue).toBe(true);
  });

  it("produces stable ids and signatures across re-scans, and a schema-valid snapshot", () => {
    const a = detectForm(document);
    const b = detectForm(document);
    expect(b.fields.map((f) => f.id)).toEqual(a.fields.map((f) => f.id));
    expect(b.formSignature).toBe(a.formSignature);
    expect(document.getElementById("fname")!.getAttribute("data-ufa-id")).toBe(byName(a, "fatherName")!.id);
    expect(formSnapshotSchema.safeParse(a).success).toBe(true);
  });

  it("finds fields inside open shadow roots", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = '<label for="x">Aadhaar Number (last 4 digits)</label><input id="x" name="aadhaarLast4">';
    expect(byName(detectForm(document), "aadhaarLast4")).toMatchObject({ label: "Aadhaar Number (last 4 digits)", inShadowDom: true });
  });
});

describe("dynamic forms", () => {
  it("re-detects when a field appears (Country -> State -> District)", async () => {
    load(TEST_FORM);
    const before = detectForm(document);
    expect(byName(before, "district")).toBeUndefined();

    const changes: string[] = [];
    const w = watchForm(document, (r) => changes.push(r), { debounceMs: 20, urlPollMs: 10_000 });
    document.getElementById("stateRow")!.hidden = false;
    const slot = document.getElementById("districtSlot")!;
    slot.innerHTML = '<div class="row"><label for="district">District *</label><select id="district" name="district"><option value="">Select</option><option>Lucknow</option></select></div>';
    await new Promise((r) => setTimeout(r, 80));
    w.stop();

    expect(changes).toContain("dom");
    const after = detectForm(document);
    expect(byName(after, "state")?.visible).toBe(true);
    expect(byName(after, "district")).toMatchObject({ label: "District", options: ["Lucknow"], required: true });
    expect(after.formSignature).not.toBe(before.formSignature);
  });
});
