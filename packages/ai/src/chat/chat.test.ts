import { describe, expect, it } from "vitest";
import { verhoeffValid } from "@ufa/shared";
import { analyzeMessage, ChatLocalAIExtractor, detectIntent, detectLanguage, detectQueryFields, extractChatFacts, maskSensitiveText, replies, takeName, toDmy } from "./index";

const facts = (text: string) => Object.fromEntries(extractChatFacts(text).map((f) => [f.fieldKey, f.value]));

describe("fact extraction — spec examples", () => {
  it("father's name (spec §14)", () => {
    expect(facts("My father's name is Raj Kumar.")).toEqual({ "family.father_name": "Raj Kumar" });
  });
  it("completed B.Com in 2022", () => {
    expect(facts("I completed B.Com in 2022.")).toEqual({ "education.graduation.course": "B.Com", "education.graduation.passing_year": "2022" });
  });
  it("3 years of experience", () => {
    expect(facts("I have 3 years of experience.")).toEqual({ "employment.experience_years": "3" });
  });
  it("not an ex-serviceman", () => {
    expect(facts("I am not an ex-serviceman.")).toEqual({ "recruitment.ex_serviceman": "no" });
    expect(facts("I'm an ex serviceman")).toEqual({ "recruitment.ex_serviceman": "yes" });
  });
  it("permanent address with PIN and state", () => {
    expect(facts("My permanent address is House 12, Gandhi Nagar, Lucknow, Uttar Pradesh 226001")).toEqual({
      "contact.address_line_1": "House 12, Gandhi Nagar, Lucknow, Uttar Pradesh 226001",
      "contact.pincode": "226001",
      "contact.state": "Uttar Pradesh",
    });
  });
  it("I am married (spec §15)", () => {
    expect(facts("I am married")).toEqual({ "personal.marital_status": "Married" });
    expect(facts("I'm not married")).toEqual({ "personal.marital_status": "Unmarried" });
    expect(facts("I am single")).toEqual({ "personal.marital_status": "Unmarried" });
  });
});

describe("fact extraction — variety", () => {
  it("several facts in one message", () => {
    expect(facts("My father's name is Raj Kumar and my mother's name is Sunita Devi.")).toEqual({
      "family.father_name": "Raj Kumar",
      "family.mother_name": "Sunita Devi",
    });
  });
  it("title-cases lowercase names and strips honorifics", () => {
    expect(facts("father name: shri raj kumar")).toEqual({ "family.father_name": "Raj Kumar" });
  });
  it("does not treat occupations as names", () => {
    expect(facts("My father is a farmer")).toEqual({});
    expect(facts("My father is Mohan Lal")).toEqual({ "family.father_name": "Mohan Lal" });
  });
  it("dates in many formats", () => {
    expect(facts("I was born on 12 May 2001")).toEqual({ "personal.date_of_birth": "2001-05-12" });
    expect(facts("My DOB is 12/05/2001")).toEqual({ "personal.date_of_birth": "2001-05-12" });
    expect(facts("date of birth: May 12th, 2001")).toEqual({ "personal.date_of_birth": "2001-05-12" });
    expect(toDmy("2001-05-12")).toBe("12/05/2001");
  });
  it("school results with percentages", () => {
    expect(facts("I passed 10th in 2017 with 87.6% and 12th in 2019 with 78 percent")).toEqual({
      "education.class_10.passing_year": "2017",
      "education.class_10.percentage": "87.6",
      "education.class_12.passing_year": "2019",
      "education.class_12.percentage": "78",
    });
  });
  it("degree with university and CGPA; ignores plans", () => {
    expect(facts("I did MBA from University of Lucknow in 2024 with CGPA 8.2")).toEqual({
      "education.post_graduation.course": "MBA",
      "education.post_graduation.passing_year": "2024",
      "education.post_graduation.cgpa": "8.2",
      "education.post_graduation.university": "University of Lucknow",
    });
    expect(facts("I want to do MBA next year")).toEqual({});
  });
  it("category, gender, nationality, government employee", () => {
    expect(facts("My category is OBC")).toEqual({ "recruitment.category": "OBC" });
    expect(facts("I belong to the SC category")).toEqual({ "recruitment.category": "SC" });
    expect(facts("I am female and I am an Indian citizen")).toEqual({ "personal.gender": "Female", "personal.nationality": "Indian" });
    expect(facts("I am not a government employee")).toEqual({ "recruitment.government_employee": "no" });
  });
  it("work, contact details", () => {
    expect(facts("I work at Infosys as Software Engineer")).toEqual({ "employment.company": "Infosys", "employment.designation": "Software Engineer" });
    expect(facts("my mobile number is +91 98765 43210 and email is asha@example.com")).toEqual({
      "contact.mobile": "9876543210",
      "contact.email": "asha@example.com",
    });
    expect(facts("I live in Kanpur, Uttar Pradesh")).toEqual({ "contact.city": "Kanpur", "contact.state": "Uttar Pradesh" });
  });
  it("identity numbers only with their keyword and a valid format", () => {
    let aadhaar = "23456789012";
    for (let d = 0; d <= 9; d++) if (verhoeffValid(aadhaar + d)) { aadhaar += d; break; }
    expect(facts(`my aadhaar number is ${aadhaar}`)).toEqual({ "identity.aadhaar_number": aadhaar });
    expect(facts("my pan is abcpv1234k")).toEqual({ "identity.pan_number": "ABCPV1234K" });
    expect(facts("call me at 5")).toEqual({});
  });
  it("never invents anything from small talk", () => {
    expect(facts("hello, how are you?")).toEqual({});
    expect(facts("thanks!")).toEqual({});
  });
});

describe("Hinglish and Hindi", () => {
  it("Hinglish names, marital status, education, experience", () => {
    expect(facts("Mere papa ka naam Raj Kumar hai")).toEqual({ "family.father_name": "Raj Kumar" });
    expect(facts("meri maa ka naam hai sunita devi")).toEqual({ "family.mother_name": "Sunita Devi" });
    expect(facts("Mera naam Asha Verma hai")).toEqual({ "personal.full_name": "Asha Verma" });
    expect(facts("meri shaadi ho gayi hai")).toEqual({ "personal.marital_status": "Married" });
    expect(facts("main ex-serviceman nahi hoon")).toEqual({ "recruitment.ex_serviceman": "no" });
    expect(facts("Maine 2022 mein B.Com complete kiya")).toEqual({ "education.graduation.course": "B.Com", "education.graduation.passing_year": "2022" });
    expect(facts("mujhe 2 saal ka experience hai")).toEqual({ "employment.experience_years": "2" });
  });
  it("Hindi (Devanagari)", () => {
    expect(facts("मेरे पिता का नाम राज कुमार है")).toEqual({ "family.father_name": "राज कुमार" });
    expect(facts("मेरी माता का नाम सुनीता देवी है")).toEqual({ "family.mother_name": "सुनीता देवी" });
    expect(facts("मैं अविवाहित हूँ")).toEqual({ "personal.marital_status": "Unmarried" });
    expect(facts("मेरी जन्म तिथि 12/05/2001 है")).toEqual({ "personal.date_of_birth": "2001-05-12" });
  });
  it("detects the reply language", () => {
    expect(detectLanguage("My father's name is Raj Kumar")).toBe("en");
    expect(detectLanguage("mere papa ka naam Raj Kumar hai")).toBe("hinglish");
    expect(detectLanguage("मेरे पिता का नाम राज कुमार है")).toBe("hi");
  });
  it("takeName stops at connectors", () => {
    expect(takeName("Raj Kumar and he is a farmer")?.value).toBe("Raj Kumar");
    expect(takeName("राज कुमार है")?.value).toBe("राज कुमार");
  });
});

describe("intents", () => {
  it("questions about stored data", () => {
    expect(detectIntent("What is my father's name?", false)).toBe("QUERY");
    expect(detectQueryFields("What is my father's name?")).toEqual(["family.father_name"]);
    expect(detectIntent("mera dob kya hai", false)).toBe("QUERY");
    expect(detectQueryFields("mera dob kya hai")).toEqual(["personal.date_of_birth"]);
    expect(detectIntent("मेरे पिता का नाम क्या है?", false)).toBe("QUERY");
  });
  it("summary, help, unknown", () => {
    expect(detectIntent("What do you know about me?", false)).toBe("SUMMARY");
    expect(detectIntent("mere baare mein kya pata hai", false)).toBe("SUMMARY");
    expect(detectIntent("hello", false)).toBe("HELP");
    expect(detectIntent("purple elephants", false)).toBe("UNKNOWN");
  });
  it("questions in name-statement form are not read as names", () => {
    expect(extractChatFacts("मेरी माता का नाम क्या है?")).toEqual([]);
    expect(extractChatFacts("mere papa ka naam kya hai")).toEqual([]);
    expect(extractChatFacts("My father's name is what?")).toEqual([]);
    expect(detectIntent("मेरी माता का नाम क्या है?", false)).toBe("QUERY");
    expect(detectQueryFields("मेरी माता का नाम क्या है?")).toEqual(["family.mother_name"]);
  });
  it("facts beat questions", () => {
    expect(detectIntent("My father's name is Raj Kumar?", true)).toBe("UPDATE");
  });
});

describe("masking before storage", () => {
  it("masks Aadhaar, PAN and long account numbers but keeps mobiles readable", () => {
    let aadhaar = "23456789012";
    for (let d = 0; d <= 9; d++) if (verhoeffValid(aadhaar + d)) { aadhaar += d; break; }
    const text = `aadhaar ${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}, pan ABCPV1234K, account 123456789012345, mobile 9876543210`;
    const { text: out, masked } = maskSensitiveText(text, extractChatFacts(text));
    expect(masked).toBe(true);
    expect(out).not.toContain(aadhaar.slice(4, 8));
    expect(out).not.toContain("ABCPV1234K");
    expect(out).not.toContain("123456789012345");
    expect(out).toContain("9876543210");
  });
});

describe("replies", () => {
  it("uses the spec §16 conflict wording", () => {
    expect(replies.conflict("en", "family.father_name", "Raj Kumar", "Rajesh Kumar")).toBe(
      'I currently have "Raj Kumar" saved as your Father\'s Name. Should I update it to "Rajesh Kumar"?',
    );
    expect(replies.conflict("hi", "family.father_name", "राज कुमार", "राजेश कुमार")).toContain("पिता का नाम");
  });
});

describe("local AI fallback (mocked)", () => {
  const mock = (content: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }))) as unknown as typeof fetch;

  it("is used only when rules find nothing, and drops values not present in the message", async () => {
    const ai = new ChatLocalAIExtractor({
      baseUrl: "http://ai",
      model: "m",
      fetchImpl: mock({
        facts: [
          { field_key: "family.guardian_name", value: "Ramesh Chandra", confidence: 0.99 },
          { field_key: "family.mother_name", value: "Invented Name", confidence: 0.99 },
        ],
      }),
    });
    const r = await analyzeMessage("ghar par Ramesh Chandra mere guardian hain", ai);
    expect(r.intent).toBe("UPDATE");
    expect(r.localAiUsed).toBe(true);
    expect(r.facts).toEqual([{ fieldKey: "family.guardian_name", value: "Ramesh Chandra", confidence: 0.8, method: "local_ai", raw: "Ramesh Chandra" }]);
  });

  it("is not called when rules already understood the message", async () => {
    const ai = new ChatLocalAIExtractor({ baseUrl: "http://ai", model: "m", fetchImpl: (() => { throw new Error("should not be called"); }) as unknown as typeof fetch });
    const r = await analyzeMessage("My father's name is Raj Kumar", ai);
    expect(r.localAiUsed).toBe(false);
    expect(r.facts[0]!.fieldKey).toBe("family.father_name");
  });
});

describe("job-search facts for the extension assistant", () => {
  it("reads city, notice period, expected salary, skills, relocation and LinkedIn", () => {
    const get = (t: string) => Object.fromEntries(extractChatFacts(t).map((f) => [f.fieldKey, f.value]));
    expect(get("meri current city Lucknow hai")).toEqual({ "contact.city": "Lucknow" });
    expect(get("I live in Noida")).toEqual({ "contact.city": "Noida" });
    expect(get("My notice period is 60 days and I have 6 years experience")).toMatchObject({ "employment.notice_period": "60 days", "employment.experience_years": "6" });
    expect(get("my expected salary is 18 LPA")).toEqual({ "employment.desired_salary": "18 LPA" });
    expect(get("my skills are Jira, SQL, Power BI")).toEqual({ "employment.skills": "Jira, SQL, Power BI" });
    expect(get("I am willing to relocate")).toEqual({ "employment.willing_to_relocate": "yes" });
    expect(get("linkedin.com/in/asha-verma-12345")).toEqual({ "employment.linkedin_url": "https://linkedin.com/in/asha-verma-12345" });
  });
});
