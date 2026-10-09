import { describe, expect, it } from "vitest";
import { verhoeffValid } from "@ufa/shared";
import { extractFields, LocalAIDocumentExtractor, MAX_MODEL_CONFIDENCE, mergeCandidates, validateCandidates } from "./extract";
import { detectFileType, pdfHasActiveContent, sanitizeFilename } from "./fileType";
import { allowedFieldsFor } from "./targets";

// Synthetic test data only — no real person's documents.
function fakeAadhaar(prefix = "23456789012") {
  for (let d = 0; d <= 9; d++) if (verhoeffValid(prefix + d)) return prefix + d;
  throw new Error("unreachable");
}
const AADHAAR = fakeAadhaar();
const spaced = `${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`;

const AADHAAR_TEXT = `
भारत सरकार
Government of India
Asha Verma
जन्म तिथि / DOB : 12/05/2001
महिला / FEMALE
${spaced}
मेरा आधार, मेरी पहचान
Address: D/O Raj Kumar, House 12, Gandhi Nagar,
Lucknow, Uttar Pradesh - 226001
`;

const PAN_TEXT = `
INCOME TAX DEPARTMENT  GOVT. OF INDIA
Permanent Account Number Card
ABCPV1234K
नाम / Name
ASHA VERMA
पिता का नाम / Father's Name
RAJ KUMAR
जन्म की तारीख / Date of Birth
12/05/2001
`;

const MARKSHEET_10 = `
CENTRAL BOARD OF SECONDARY EDUCATION
SECONDARY SCHOOL EXAMINATION, 2017
Roll No. 4123456
Name of Candidate: ASHA VERMA
Mother's Name: SUNITA VERMA
Father's / Guardian's Name: RAJ KUMAR
Date of Birth: 15/05/2001
School: Kendriya Vidyalaya Gomti Nagar
Grand Total 438 / 500
RESULT PASS
`;

const DEGREE_TEXT = `
University of Lucknow
Bachelor of Commerce
Enrolment No: LU2019COM0456
Roll No: 1902345
CGPA: 8.4
Examination held in May 2022
`;

const pick = (cands: { fieldKey: string; value: string }[], key: string) => cands.filter((c) => c.fieldKey === key).map((c) => c.value);

describe("rule extraction", () => {
  it("extracts Aadhaar fields and normalizes them through the profile validators", async () => {
    const { candidates } = await extractFields("aadhaar", AADHAAR_TEXT);
    expect(pick(candidates, "identity.aadhaar_number")).toEqual([AADHAAR]);
    expect(pick(candidates, "personal.date_of_birth")).toEqual(["2001-05-12"]);
    expect(pick(candidates, "personal.gender")).toEqual(["Female"]);
    expect(pick(candidates, "personal.full_name")).toEqual(["Asha Verma"]);
    expect(pick(candidates, "family.father_name")).toEqual(["Raj Kumar"]);
    expect(pick(candidates, "contact.pincode")).toEqual(["226001"]);
    expect(pick(candidates, "contact.state")).toEqual(["Uttar Pradesh"]);
  });

  it("ignores 12-digit numbers that fail the Aadhaar checksum", async () => {
    const bad = AADHAAR.slice(0, 11) + ((Number(AADHAAR[11]) + 1) % 10);
    const { candidates } = await extractFields("aadhaar", `DOB: 01/01/2000\n${bad}`);
    expect(pick(candidates, "identity.aadhaar_number")).toEqual([]);
  });

  it("extracts PAN card fields (bilingual labels)", async () => {
    const { candidates } = await extractFields("pan", PAN_TEXT);
    expect(pick(candidates, "identity.pan_number")).toEqual(["ABCPV1234K"]);
    expect(pick(candidates, "personal.full_name")).toEqual(["ASHA VERMA"]);
    expect(pick(candidates, "family.father_name")).toEqual(["RAJ KUMAR"]);
    expect(pick(candidates, "personal.date_of_birth")).toEqual(["2001-05-12"]);
  });

  it("extracts class 10 marksheet fields into education.class_10.*", async () => {
    const { candidates } = await extractFields("class_10_marksheet", MARKSHEET_10);
    expect(pick(candidates, "education.class_10.roll_number")).toEqual(["4123456"]);
    expect(pick(candidates, "education.class_10.passing_year")).toEqual(["2017"]);
    expect(pick(candidates, "education.class_10.percentage")).toEqual(["87.6"]);
    expect(pick(candidates, "education.class_10.board")[0]).toMatch(/CENTRAL BOARD/);
    expect(pick(candidates, "personal.full_name")).toEqual(["ASHA VERMA"]);
    expect(pick(candidates, "family.mother_name")).toEqual(["SUNITA VERMA"]);
    expect(pick(candidates, "family.father_name")).toEqual(["RAJ KUMAR"]);
    // Different DOB than the Aadhaar text above: the conflict scenario from the spec.
    expect(pick(candidates, "personal.date_of_birth")).toEqual(["2001-05-15"]);
  });

  it("extracts graduation fields", async () => {
    const { candidates } = await extractFields("degree", DEGREE_TEXT);
    expect(pick(candidates, "education.graduation.university")).toEqual(["University of Lucknow"]);
    expect(pick(candidates, "education.graduation.course")).toEqual(["Bachelor of Commerce"]);
    expect(pick(candidates, "education.graduation.cgpa")).toEqual(["8.4"]);
    expect(pick(candidates, "education.graduation.registration_number")).toEqual(["LU2019COM0456"]);
    expect(pick(candidates, "education.graduation.passing_year")).toEqual(["2022"]);
  });

  it("extracts certificate data with the 'certify that ... son of ...' pattern", async () => {
    const text = "This is to certify that Shri Amit Singh son of Shri Ravi Singh resident of Patna belongs to the Kurmi caste which is recognised as Other Backward Class. Certificate No: BC/2023/00451";
    const { candidates } = await extractFields("caste_certificate", text);
    expect(pick(candidates, "personal.full_name")).toEqual(["Amit Singh"]);
    expect(pick(candidates, "family.father_name")).toEqual(["Ravi Singh"]);
    expect(pick(candidates, "recruitment.category")).toEqual(["OBC"]);
    expect(pick(candidates, "recruitment.caste_certificate_number")).toEqual(["BC/2023/00451"]);
  });

  it("extracts resume contact details", async () => {
    const { candidates } = await extractFields("resume", "Asha Verma\nasha.verma@example.com | +91 98765 43210\nSkills: Excel");
    expect(pick(candidates, "contact.email")).toEqual(["asha.verma@example.com"]);
    expect(pick(candidates, "contact.mobile")).toEqual(["9876543210"]);
    expect(pick(candidates, "personal.full_name")).toEqual(["Asha Verma"]);
  });

  it("never extracts from photographs/signatures and drops fields not allowed for the type", () => {
    expect(allowedFieldsFor("photograph")).toEqual([]);
    const v = validateCandidates("class_10_marksheet", [{ fieldKey: "bank.account_number", value: "123456789012", confidence: 0.9, method: "local_ai" }]);
    expect(v).toEqual([]);
  });
});

describe("merging rules and local AI", () => {
  const r = { fieldKey: "personal.date_of_birth", value: "2001-05-12", confidence: 0.85, method: "rules" as const };

  it("boosts agreement", () => {
    const [m] = mergeCandidates([r], [{ ...r, method: "local_ai", confidence: 0.8 }]);
    expect(m!.method).toBe("rules+local_ai");
    expect(m!.confidence).toBeCloseTo(0.9);
  });

  it("keeps both on disagreement with lowered confidence", () => {
    const m = mergeCandidates([r], [{ ...r, value: "2001-05-21", method: "local_ai", confidence: 0.85 }]);
    expect(m).toHaveLength(2);
    expect(m.every((c) => c.confidence <= 0.68)).toBe(true);
  });
});

describe("LocalAIDocumentExtractor (mocked Ollama)", () => {
  function mockFetch(content: unknown, status = 200): typeof fetch {
    return (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.format.properties.fields.items.properties.field_key.enum).toContain("identity.pan_number");
      return new Response(JSON.stringify({ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }), { status });
    }) as typeof fetch;
  }

  it("caps model confidence and drops keys outside the allowed list", async () => {
    const ex = new LocalAIDocumentExtractor({
      baseUrl: "http://ai.local",
      model: "test",
      fetchImpl: mockFetch({
        fields: [
          { field_key: "identity.pan_number", value: "ABCPV1234K", confidence: 0.99 },
          { field_key: "bank.account_number", value: "123", confidence: 0.99 },
        ],
      }),
    });
    const out = await ex.extract("pan", PAN_TEXT, allowedFieldsFor("pan"));
    expect(out).toEqual([{ fieldKey: "identity.pan_number", value: "ABCPV1234K", confidence: MAX_MODEL_CONFIDENCE, method: "local_ai" }]);
  });

  it("falls back to rules when the model returns garbage", async () => {
    const ex = new LocalAIDocumentExtractor({ baseUrl: "http://ai.local", model: "test", fetchImpl: mockFetch("not json") });
    const res = await extractFields("pan", PAN_TEXT, ex);
    expect(res.localAiUsed).toBe(false);
    expect(res.localAiError).toMatch(/non-JSON/);
    expect(pick(res.candidates, "identity.pan_number")).toEqual(["ABCPV1234K"]);
  });

  it("merges model output that agrees with the rules", async () => {
    const ex = new LocalAIDocumentExtractor({
      baseUrl: "http://ai.local",
      model: "test",
      fetchImpl: mockFetch({ fields: [{ field_key: "identity.pan_number", value: "abcpv1234k", confidence: 0.7 }] }),
    });
    const res = await extractFields("pan", PAN_TEXT, ex);
    const pan = res.candidates.find((c) => c.fieldKey === "identity.pan_number")!;
    expect(res.localAiUsed).toBe(true);
    expect(pan.method).toBe("rules+local_ai");
    expect(pan.confidence).toBe(0.99);
  });
});

describe("file validation", () => {
  it("detects types by magic bytes, not by name", () => {
    expect(detectFileType(Buffer.from("%PDF-1.7\n..."))?.mime).toBe("application/pdf");
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.mime).toBe("image/png");
    expect(detectFileType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))?.mime).toBe("image/webp");
    expect(detectFileType(Buffer.from("MZ\x90\x00 windows exe"))).toBeNull();
    expect(detectFileType(Buffer.from("<html><script>"))).toBeNull();
  });

  it("flags PDFs with active content", () => {
    expect(pdfHasActiveContent(Buffer.from("%PDF-1.4 << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"))).toBe(true);
    expect(pdfHasActiveContent(Buffer.from("%PDF-1.4 << /Type /Catalog >>"))).toBe(false);
  });

  it("reads skills and summary from a CV for review", async () => {
    const cv = [
      "Asha Verma",
      "asha.verma@example.test | 9876543210",
      "Professional Summary",
      "Commerce graduate with two years of experience in accounts and GST filing for small businesses.",
      "Skills:",
      "• Tally ERP, MS Excel, GST returns",
      "• Communication; Hindi typing",
      "Education",
      "B.Com, Lucknow University, 2022",
    ].join("\n");
    const { candidates } = await extractFields("resume", cv);
    const get = (k: string) => candidates.find((c) => c.fieldKey === k)?.value;
    expect(get("employment.skills")).toBe("Tally ERP, MS Excel, GST returns, Communication, Hindi typing");
    expect(get("employment.summary")).toMatch(/^Commerce graduate/);
    expect(get("employment.skills")).not.toMatch(/B\.Com/);
  });

  it("reads the latest job, education and LinkedIn from a one-line-per-entry CV", async () => {
    const cv = [
      "ASHA VERMA",
      "asha.verma@example.test | 9876543210 | linkedin.com/in/asha-verma-12345",
      "EXPERIENCE",
      "Senior Accountant | Sharma Traders Pvt. Ltd., Lucknow, India Jul 2023 – Present",
      "• Managed GST returns",
      "Accounts Assistant | Gupta & Co., Kanpur Jan 2021 – Jun 2023",
      "EDUCATION",
      "M.Com, Accounting | Lucknow University, Lucknow | 2019 – 2021",
      "B.Com | Christ Church College, Kanpur | 2016 – 2019",
    ].join("\n");
    const { candidates } = await extractFields("resume", cv);
    const get = (k: string) => candidates.find((c) => c.fieldKey === k)?.value;
    expect(get("employment.designation")).toBe("Senior Accountant");
    expect(get("employment.company")).toBe("Sharma Traders Pvt. Ltd.");
    expect(get("employment.linkedin_url")).toBe("https://linkedin.com/in/asha-verma-12345");
    expect(get("education.post_graduation.course")).toBe("M.Com");
    expect(get("education.post_graduation.specialization")).toBe("Accounting");
    expect(get("education.post_graduation.passing_year")).toBe("2021");
    expect(get("education.graduation.course")).toBe("B.Com");
    expect(get("education.graduation.university")).toBe("Christ Church College");
    expect(get("education.highest_qualification")).toBe("M.Com, Accounting");
  });

  it("sanitizes filenames", () => {
    expect(sanitizeFilename("..\\..\\windows\\evil<x>.pdf", "pdf")).toBe("evilx.pdf");
    expect(sanitizeFilename("../", "png")).toBe("document.png");
    expect(sanitizeFilename("मार्कशीट 10th.jpg", "jpg")).toBe("मार्कशीट 10th.jpg");
  });
});
