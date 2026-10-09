// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FillInstruction, FillValueType } from "../fill";
import type { FormSnapshot } from "../types";
import { detectForm } from "./detect";
import { fillForm, findFieldElement, type FillItem } from "./fill";

const TEST_FORM = readFileSync(path.resolve(__dirname, "../../../../apps/test-form/public/index.html"), "utf8");

let submits = 0;

function load() {
  document.open();
  document.write(
    TEST_FORM.replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<iframe[^>]*><\/iframe>/g, "")
      .replace(/<link[^>]*>/g, "")
      .replace(/<img[^>]*src="\/captcha\.svg"[^>]*>/, '<img alt="captcha image">'),
  );
  document.close();
  // The parts of form.js the filler interacts with.
  const country = document.getElementById("country") as HTMLSelectElement;
  country.addEventListener("change", () => (document.getElementById("stateRow")!.hidden = country.value !== "India"));
  const qual = document.getElementById("qual") as HTMLInputElement;
  const list = document.getElementById("qualList")!;
  qual.addEventListener("focus", () => (list.hidden = false));
  list.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t.getAttribute("role") === "option") qual.value = t.textContent ?? "";
  });
  submits = 0;
  document.getElementById("application")!.addEventListener("submit", (e) => {
    submits++;
    e.preventDefault();
  });
}

const byName = (snap: FormSnapshot, name: string) => snap.fields.find((f) => f.name === name)!;
const item = (snap: FormSnapshot, name: string, value: string, opts: { option?: string; valueType?: FillValueType; overwrite?: boolean } = {}): FillItem => {
  const field = byName(snap, name);
  const instruction: FillInstruction = { fieldId: field.id, value, valueType: opts.valueType ?? "text", option: opts.option ?? null, overwrite: opts.overwrite ?? false };
  return { field, instruction };
};
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

describe("fillForm on the test recruitment form", () => {
  beforeEach(load);

  it("fills text, date, select, radio and dependent fields in order, and never submits", async () => {
    const snap = detectForm(document);
    const events: string[] = [];
    input("candidateName").addEventListener("input", () => events.push("input"));
    input("candidateName").addEventListener("change", () => events.push("change"));

    const run = await fillForm(document, [
      item(snap, "candidateName", "Ramesh Kumar"),
      item(snap, "dob", "2001-04-09", { valueType: "date" }),
      item(snap, "gender", "Male", { option: "Male" }),
      item(snap, "maritalStatus", "Unmarried", { option: "Unmarried" }),
      item(snap, "country", "India", { option: "India" }),
      item(snap, "state", "Bihar", { option: "Bihar" }), // hidden until country = India
      item(snap, "category", "General", { option: "UR" }),
      item(snap, "txtMobile", "9876543210"),
    ]);

    expect(run.results.every((r) => r.status === "filled")).toBe(true);
    expect(input("candidateName").value).toBe("Ramesh Kumar");
    expect(input("dob").value).toBe("2001-04-09");
    expect(document.querySelector<HTMLInputElement>('input[name=gender][value="M"]')!.checked).toBe(true);
    expect(document.querySelector<HTMLSelectElement>("#state")!.value).toBe("Bihar");
    expect(document.querySelector<HTMLSelectElement>("#cat")!.value).toBe("UR");
    expect(events).toEqual(["input", "change"]);
    expect(input("candidateName").getAttribute("data-ufa-filled")).toBe("1");
    expect(submits).toBe(0);
  });

  it("uses the native setter, so framework value trackers see the change", async () => {
    const snap = detectForm(document);
    const el = input("fatherName");
    // Simulate React's per-instance value property that swallows direct assignment.
    let tracked = "";
    Object.defineProperty(el, "value", {
      configurable: true,
      get: () => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.get!.call(el),
      set: (v: string) => {
        tracked = v;
      },
    });
    const run = await fillForm(document, [item(snap, "fatherName", "Suresh Kumar")]);
    expect(run.results[0]!.status).toBe("filled");
    expect(el.value).toBe("Suresh Kumar");
    expect(tracked).toBe("");
  });

  it("picks an option of a custom ARIA combobox like a user would", async () => {
    const snap = detectForm(document);
    const qual = snap.fields.find((f) => f.htmlId === "qual")!;
    const run = await fillForm(document, [{ field: qual, instruction: { fieldId: qual.id, value: "Graduation", valueType: "text", option: "Graduation", overwrite: false } }], { optionWaitMs: 300 });
    expect(run.results[0]).toEqual({ fieldId: qual.id, status: "filled" });
    expect((document.getElementById("qual") as HTMLInputElement).value).toBe("Graduation");
  });

  it("skips manual fields, existing values and invalid values, and explains why", async () => {
    const snap = detectForm(document);
    input("fatherName").value = "Typed by user";
    const run = await fillForm(document, [
      item(snap, "captchaCode", "ABCD"),
      item(snap, "otp", "123456"),
      item(snap, "fatherName", "Suresh Kumar"),
      item(snap, "txtMobile", "+91 98765 43210"),
      item(snap, "maritalStatus", "Single", { option: "Single" }),
      item(snap, "photo", "x"),
    ]);
    expect(run.results.map((r) => r.reason)).toEqual(["manual_field", "manual_field", "has_value", "too_long", "no_option", "not_fillable"]);
    expect(input("captchaCode").value).toBe("");
    expect(input("otp").value).toBe("");
    expect(input("fatherName").value).toBe("Typed by user");
  });

  it("replaces an existing value only when allowed, and undo restores everything", async () => {
    const snap = detectForm(document);
    input("fatherName").value = "Typed by user";
    const run = await fillForm(document, [
      item(snap, "fatherName", "Suresh Kumar", { overwrite: true }),
      item(snap, "gender", "Female", { option: "Female" }),
      item(snap, "maritalStatus", "Married", { option: "Married" }),
    ]);
    expect(input("fatherName").value).toBe("Suresh Kumar");
    expect(run.undo()).toBe(3);
    expect(input("fatherName").value).toBe("Typed by user");
    expect(document.querySelector<HTMLInputElement>('input[name=gender]:checked')).toBeNull();
    expect(document.querySelector<HTMLSelectElement>("#marital")!.selectedIndex).toBe(0);
    expect(input("fatherName").hasAttribute("data-ufa-filled")).toBe(false);
  });

  it("skips fields that are hidden at fill time", async () => {
    const snap = detectForm(document);
    const run = await fillForm(document, [item(snap, "state", "Bihar", { option: "Bihar" })]);
    expect(run.results[0]).toMatchObject({ status: "skipped", reason: "hidden" });
  });

  it("finds fields inside open shadow roots", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<label for="x">Inner</label><input id="x" data-ufa-id="fz">';
    expect(findFieldElement(document, "fz")).toBe(root.getElementById("x"));
  });
});

describe("visual mode", () => {
  it("types the same values as normal mode, shows a cursor and removes it afterwards", async () => {
    document.body.innerHTML = `<form><label for="c">Current city</label><input id="c" name="city"><label for="t">Tell us about yourself</label><textarea id="t"></textarea></form>`;
    const snap = detectForm(document);
    const inputs: string[] = [];
    document.getElementById("c")!.addEventListener("input", (e) => inputs.push((e.target as HTMLInputElement).value));
    const items: FillItem[] = snap.fields.map((f) => ({
      field: f,
      instruction: { fieldId: f.id, value: f.kind === "textarea" ? "I build AI products." : "Noida", valueType: "text" as FillValueType, option: null, overwrite: false } as FillInstruction,
    }));
    const run = await fillForm(document, items, { visual: true });
    expect(run.results.every((r) => r.status === "filled")).toBe(true);
    expect((document.getElementById("c") as HTMLInputElement).value).toBe("Noida");
    expect((document.getElementById("t") as HTMLTextAreaElement).value).toBe("I build AI products.");
    expect(inputs.length).toBeGreaterThan(1); // typed progressively, not in one go
    expect(inputs.at(-1)).toBe("Noida");
    await new Promise((r) => setTimeout(r, 400));
    expect(document.getElementById("__ufa_cursor")).toBeNull();
  }, 20_000);
});
