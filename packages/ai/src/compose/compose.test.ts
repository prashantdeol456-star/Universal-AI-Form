import { describe, expect, it } from "vitest";
import { GeminiProvider } from "../providers/gemini";
import {
  EMAIL_PLACEHOLDER_KEYS,
  composeSystemPrompt,
  detectComposeIntent,
  detectRole,
  isEmailPlaceholderKey,
  renderDraft,
  sanitizeDraft,
  templateDraft,
} from "./index";

// Synthetic values only.
const values = new Map([
  ["personal.full_name", "Asha Verma"],
  ["contact.email", "asha.verma@example.test"],
  ["education.highest_qualification", "B.Com"],
  ["employment.skills", "Tally ERP, GST returns"],
  ["identity.aadhaar_number", "234567890123"],
]);

describe("email placeholders", () => {
  it("allows everyday details only", () => {
    expect(isEmailPlaceholderKey("personal.full_name")).toBe(true);
    expect(isEmailPlaceholderKey("employment.skills")).toBe(true);
    for (const k of ["identity.aadhaar_number", "identity.pan_number", "bank.account_number", "recruitment.caste", "family.father_name", "personal.religion", "employment.salary"]) {
      expect(isEmailPlaceholderKey(k), k).toBe(false);
    }
    expect(EMAIL_PLACEHOLDER_KEYS.some((k) => k.startsWith("identity.") || k.startsWith("bank."))).toBe(false);
  });

  it("fills values, marks missing ones and drops forbidden placeholders", () => {
    const r = renderDraft(
      {
        subject: "Application – {{personal.full_name}}",
        body: "I hold {{education.highest_qualification}} and {{employment.experience_years}} years.\nAadhaar: {{identity.aadhaar_number}}\n{{bogus.key}}\n\nRegards,\n{{personal.full_name}}\n{{contact.mobile}}\n{{contact.email}}",
      },
      values,
    );
    expect(r.subject).toBe("Application – Asha Verma");
    expect(r.body).toContain("I hold B.Com and [Total Experience (years)] years.");
    expect(r.body).not.toContain("234567890123");
    expect(r.body).toContain("Aadhaar:");
    expect(r.body).not.toMatch(/\{\{|\}\}|bogus/);
    // Signature line with an unknown mobile is dropped, the others stay.
    expect(r.body.endsWith("Regards,\nAsha Verma\nasha.verma@example.test")).toBe(true);
    expect(r.missing.map((m) => m.key).sort()).toEqual(["contact.mobile", "employment.experience_years"]);
    expect(r.used.sort()).toEqual(["contact.email", "education.highest_qualification", "personal.full_name"]);
  });

  it("rejects malformed model output and strips markup", () => {
    expect(sanitizeDraft({ subject: "x" })).toBeNull();
    expect(sanitizeDraft("text")).toBeNull();
    expect(sanitizeDraft({ subject: "Hi<script>", body: "<b>Hello</b>\u0007 there" })).toEqual({ subject: "Hi", body: "Hello there" });
    // Double-escaped line breaks from the model become real ones.
    expect(sanitizeDraft({ subject: "S", body: "Dear Sir,\\n\\nI apply." })!.body).toBe("Dear Sir,\n\nI apply.");
  });
});

describe("templates (no AI)", () => {
  it("detects intent and role in English, Hinglish and Hindi", () => {
    expect(detectComposeIntent("write a job application for the post of Accountant at Sharma Traders")).toBe("job_application");
    expect(detectComposeIntent("HR ko follow up mail likho")).toBe("follow_up");
    expect(detectComposeIntent("2 din ki chutti chahiye")).toBe("leave");
    expect(detectComposeIntent("मुझे नौकरी के लिए आवेदन लिखना है")).toBe("job_application");
    expect(detectRole("apply for the post of accountant at Sharma Traders")).toBe("Accountant");
    expect(detectRole("job application please")).toBeNull();
  });

  it("builds a job application from what the profile has", () => {
    const d = templateDraft({ instruction: "apply for the position of Data Entry Operator", tone: "formal", language: "en" }, new Set(values.keys()));
    const r = renderDraft(d, values);
    expect(r.subject).toBe("Application for Data Entry Operator – Asha Verma");
    expect(r.body).toContain("I hold B.Com.");
    expect(r.body).toContain("My key skills include Tally ERP, GST returns.");
    expect(r.body).not.toContain("years of experience"); // not in the profile, so not claimed
    expect(r.body).toContain("attached my resume");
  });

  it("writes Hindi templates", () => {
    const d = templateDraft({ instruction: "नौकरी के लिए आवेदन", tone: "formal", language: "hi" }, new Set(values.keys()));
    expect(renderDraft(d, values).body).toContain("मेरी शैक्षणिक योग्यता B.Com है।");
  });
});

describe("GeminiProvider.composeEmail (mocked REST)", () => {
  it("sends the request and placeholder keys, never values", async () => {
    let sent = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      const draft = { subject: "Application – {{personal.full_name}}", body: "Dear Sir,\nI hold {{education.highest_qualification}}.\nRegards,\n{{personal.full_name}}" };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 60 } }));
    }) as unknown as typeof fetch;
    const g = new GeminiProvider({ apiKey: "test-key", model: "gemini-3.5-flash", fetchImpl });
    const input = {
      instruction: "job application for accountant",
      tone: "formal" as const,
      language: "en" as const,
      keys: [{ key: "personal.full_name", label: "Full Name" }, { key: "education.highest_qualification", label: "Highest Qualification" }],
    };
    const { draft, usage } = await g.composeEmail(input);
    for (const v of values.values()) expect(sent).not.toContain(v);
    expect(sent).toContain("{{personal.full_name}} = Full Name");
    expect(sent).toContain("job application for accountant");
    expect(composeSystemPrompt(input)).toMatch(/Never invent/);
    expect(usage.outputTokens).toBe(60);
    expect(renderDraft(draft, values).body).toBe("Dear Sir,\nI hold B.Com.\nRegards,\nAsha Verma");
  });

  it("includes the previous draft (placeholders, not values) when refining", async () => {
    let sent = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"subject":"s","body":"b"}' }] } }] }));
    }) as unknown as typeof fetch;
    const g = new GeminiProvider({ apiKey: "k", model: "m", fetchImpl });
    await g.composeEmail({ instruction: "make it shorter", tone: "friendly", language: "hinglish", keys: [], previous: { subject: "S {{personal.full_name}}", body: "B" } });
    expect(sent).toContain("Revise it");
    expect(sent).toContain("{{personal.full_name}}");
    expect(sent).toContain("Hinglish");
  });
});
