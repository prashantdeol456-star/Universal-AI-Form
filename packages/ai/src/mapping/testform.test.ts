// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectForm } from "@ufa/form-engine/dom";
import { mapForm } from "./engine";
import type { ProfileValue } from "./types";

/**
 * End-to-end on the local test website: real detector output -> mapping engine,
 * with a realistic (partly incomplete) profile.
 */
const html = readFileSync(path.resolve(__dirname, "../../../../apps/test-form/public/index.html"), "utf8");

const v = (value: string, verified = true, sensitive = false): ProfileValue => ({ value, verified, sensitive });
const profile = new Map<string, ProfileValue>([
  ["personal.full_name", v("Asha Verma")],
  ["family.father_name", v("Raj Kumar")],
  ["family.mother_name", v("Sunita Devi")],
  ["personal.date_of_birth", v("2001-05-12")],
  ["personal.gender", v("Female")],
  ["personal.marital_status", v("Unmarried")],
  ["contact.address_line_1", v("House 12, Gandhi Nagar, Lucknow")],
  ["contact.mobile", v("9876543210")],
  ["contact.pincode", v("226001")],
  ["contact.state", v("Uttar Pradesh")],
  ["recruitment.category", v("OBC")],
  ["recruitment.ex_serviceman", v("no")],
  ["education.highest_qualification", v("Graduation")],
  ["education.graduation.passing_year", v("2022")],
  ["identity.aadhaar_number", v("234567890123", true, true)],
  // deliberately missing: email, country, experience, guardian
]);

describe("test recruitment form → profile mapping", () => {
  it("maps every field to the right profile field and decision", async () => {
    document.open();
    document.write(html.replace(/<script[\s\S]*?<\/script>|<link[^>]*>|<iframe[^>]*><\/iframe>/g, "").replace(/src="\/captcha\.svg"/, ""));
    document.close();
    const snap = detectForm(document);
    const res = await mapForm({ fields: snap.fields, profile });
    const by = (name: string) => {
      const f = snap.fields.find((x) => x.name === name || x.htmlId === name)!;
      return res.mappings.find((m) => m.fieldId === f.id)!;
    };

    const expectations: Array<[string, string | null, string]> = [
      ["candidateName", "personal.full_name", "AUTO_FILL"],
      ["nameMatric", "personal.full_name", "USER_REVIEW"], // a certificate name may be spelled differently
      ["fatherName", "family.father_name", "AUTO_FILL"],
      ["motherName", "family.mother_name", "AUTO_FILL"],
      ["dob", "personal.date_of_birth", "AUTO_FILL"],
      ["gender", "personal.gender", "AUTO_FILL"],
      ["maritalStatus", "personal.marital_status", "AUTO_FILL"],
      ["pita_naam", "family.father_name", "AUTO_FILL"],
      ["sthayi_pata", "contact.address_line_1", "USER_REVIEW"],
      ["txtMobile", "contact.mobile", "AUTO_FILL"],
      ["txtEmail", "contact.email", "ASK_USER"],
      ["txtPin", "contact.pincode", "AUTO_FILL"],
      ["country", "contact.country", "ASK_USER"],
      ["state", "contact.state", "USER_REVIEW"],
      ["category", "recruitment.category", "AUTO_FILL"],
      ["exsm", "recruitment.ex_serviceman", "AUTO_FILL"],
      ["experience", "employment.experience_years", "ASK_USER"],
      ["qual", "education.highest_qualification", "AUTO_FILL"],
      ["yearOfPassing", "education.graduation.passing_year", "USER_REVIEW"],
      ["guardian_nm", "family.guardian_name", "ASK_USER"],
      ["fatherOrGuardian", "family.father_name", "USER_REVIEW"],
      ["localAdult", null, "ASK_USER"], // only the AI fallback can resolve this
      ["examCentre", null, "ASK_USER"], // not a profile field
      ["photo", null, "MANUAL"],
      ["signature", null, "MANUAL"],
      ["captchaCode", null, "MANUAL"],
      ["otp", null, "MANUAL"],
      ["declaration", null, "MANUAL"],
    ];
    const problems = expectations
      .map(([name, key, decision]) => ({ name, key, decision, got: by(name) }))
      .filter((e) => e.got.profileFieldKey !== e.key || e.got.decision !== e.decision)
      .map((e) => `${e.name}: expected ${e.key}/${e.decision}, got ${e.got.profileFieldKey}/${e.got.decision} (${e.got.reason}, ${e.got.confidence})`);
    expect(problems).toEqual([]);
    expect(by("category").optionMatch).toBe("OBC");
    expect(by("gender").optionMatch).toBe("Female");
    expect(by("exsm").optionMatch).toBe("No");
    expect(by("qual").optionMatch).toBe("Graduation");
    expect(res.stats.missingValues).toBeGreaterThan(0);
  });
});
