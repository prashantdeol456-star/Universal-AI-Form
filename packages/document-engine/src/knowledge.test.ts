import { describe, expect, it } from "vitest";
import { DocxError, docxText } from "./docx";
import { declaredExtension, decodePlainText, detectFileType } from "./fileType";
import { makeDocx, makePdf, makeZip } from "./fixtures";
import { chunkDocument, excerptAround, headingOf, indexTerms, normalizeTerm, rankPassages, termsOf } from "./knowledge";
import { EmptyDocumentError, extractText, ScannedPdfError } from "./ocr";

describe("document formats (synthetic files)", () => {
  it("PDF: reads every page separately so results can cite the page", async () => {
    const pdf = makePdf([
      ["ASHA VERMA", "Product Manager, Pune", "Email: asha@example.test"],
      ["WORK EXPERIENCE", "Senior Project Manager at Acme Logistics, 2019 - 2023", "Led a team of 12 across three warehouses."],
    ]);
    const type = detectFileType(pdf)!;
    expect(type).toMatchObject({ kind: "pdf", ext: "pdf" });
    const r = await extractText(pdf, type);
    expect(r.engine).toBe("pdf-text");
    expect(r.pages).toBe(2);
    expect(r.pageTexts).toHaveLength(2);
    expect(r.pageTexts![0]).toMatch(/ASHA VERMA/);
    expect(r.pageTexts![1]).toMatch(/Acme Logistics/);
    expect(r.pageTexts![0]).not.toMatch(/Acme/);
  });

  it("PDF without a text layer is reported as a scan", async () => {
    const pdf = makePdf([["."]]);
    await expect(extractText(pdf, detectFileType(pdf)!)).rejects.toBeInstanceOf(ScannedPdfError);
  });

  it("DOCX: paragraphs, headings and table rows; never anything else in the archive", async () => {
    const docx = makeDocx(["# Work Experience", "Project Manager at Acme & Co, 2019 – 2023", ["Skill", "Years"], ["Scrum", "4"], "Contact: asha@example.test"]);
    const type = detectFileType(docx, "cv.docx")!;
    expect(type).toMatchObject({ kind: "docx", ext: "docx" });
    // Detection does not depend on the name.
    expect(detectFileType(docx, "cv.pdf")?.kind).toBe("docx");
    const r = await extractText(docx, type);
    expect(r.engine).toBe("docx");
    expect(r.text.split("\n")).toEqual(["# Work Experience", "Project Manager at Acme & Co, 2019 – 2023", "Skill | Years", "Scrum | 4", "Contact: asha@example.test"]);
  });

  it("DOCX: macro-enabled, damaged, oversized and bomb-like archives are refused", () => {
    expect(() => docxText(makeDocx(["Hello"], { macro: true }))).toThrow(/macros/);
    const good = makeDocx(["Hello"]);
    expect(() => docxText(good.subarray(0, good.length - 30))).toThrow(DocxError);
    // A document.xml that claims to be huge.
    const huge = makeZip([{ name: "word/document.xml", data: "<w:document/>", fakeSize: 60 * 1024 * 1024 }]);
    expect(() => docxText(huge)).toThrow(/too large/);
    // Highly compressible content (ratio > 200).
    const bomb = makeZip([{ name: "word/document.xml", data: "<w:p>" + "A".repeat(3_000_000) + "</w:p>" }]);
    expect(() => docxText(bomb)).toThrow(/compressed/);
    // A ZIP that is not a Word document is not detected as one.
    expect(detectFileType(makeZip([{ name: "readme.txt", data: "hi" }]), "x.docx")).toBeNull();
  });

  it("DOCX with no text is empty", async () => {
    const d = makeDocx([]);
    await expect(extractText(d, detectFileType(d)!)).rejects.toBeInstanceOf(EmptyDocumentError);
  });

  it("TXT: only when named .txt and the content is UTF-8 text", async () => {
    const txt = Buffer.from("﻿Skills: Scrum, Jira\r\nहिन्दी भी\r\n", "utf8");
    expect(detectFileType(txt, "notes.txt")).toMatchObject({ kind: "text" });
    expect(detectFileType(txt, "text/plain")).toMatchObject({ kind: "text" });
    expect(detectFileType(txt, "notes.pdf")).toBeNull();
    expect(detectFileType(txt)).toBeNull();
    const r = await extractText(txt, detectFileType(txt, "notes.txt")!);
    expect(r).toMatchObject({ engine: "plain-text", text: "Skills: Scrum, Jira\nहिन्दी भी\n" });
    // Binary or invalid UTF-8 is not text.
    expect(decodePlainText(Buffer.from([0x48, 0x00, 0x49]))).toBeNull();
    expect(decodePlainText(Buffer.from([0xc3, 0x28]))).toBeNull();
    expect(decodePlainText(Buffer.from("a\u0001b\u0002c\u0003d", "utf8"))).toBeNull();
    await expect(extractText(Buffer.from("   \n "), { kind: "text", ext: "txt", mime: "text/plain" })).rejects.toBeInstanceOf(EmptyDocumentError);
  });

  it("unsupported files are not recognised", () => {
    expect(detectFileType(Buffer.from("GIF89a....."), "a.gif")).toBeNull();
    expect(detectFileType(Buffer.from("MZ\x90\x00binary"), "cv.txt")).toBeNull();
    expect(declaredExtension("CV.DOCX")).toBe("docx");
    expect(declaredExtension("photo.jpeg")).toBe("jpg");
    expect(declaredExtension("run.exe")).toBeNull();
  });
});

describe("chunking", () => {
  it("keeps page numbers and the section heading", () => {
    const { chunks, truncated } = chunkDocument([
      { page: 1, text: "ASHA VERMA\nasha@example.test\n\nSUMMARY\nProduct manager with 8 years of experience." },
      { page: 2, text: "Work Experience:\nSenior Project Manager, Acme Logistics (2019 - 2023).\nLed warehouse automation." },
    ]);
    expect(truncated).toBe(false);
    const exp = chunks.find((c) => /Acme/.test(c.text))!;
    expect(exp).toMatchObject({ page: 2, section: "Work Experience" });
    expect(chunks.find((c) => /8 years/.test(c.text))).toMatchObject({ page: 1, section: "SUMMARY" });
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("splits long text and caps the number of chunks", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} about logistics.`).join(" ");
    const { chunks } = chunkDocument([{ page: null, text: long }]);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1_600);
    expect(chunkDocument([{ page: null, text: long }], { maxChunks: 3 })).toMatchObject({ truncated: true, chunks: { length: 3 } });
  });

  it("recognises headings", () => {
    expect(headingOf("# Education")).toBe("Education");
    expect(headingOf("WORK EXPERIENCE")).toBe("WORK EXPERIENCE");
    expect(headingOf("Key Skills:")).toBe("Key Skills");
    expect(headingOf("I worked at Acme for four years and led the team.")).toBeNull();
    // An ID number line is not a heading.
    expect(headingOf("PAN ABCDE1234F")).toBeNull();
  });
});

describe("search terms and ranking", () => {
  it("normalises words", () => {
    expect(normalizeTerm("Managing")).toBe("manag");
    expect(normalizeTerm("Projects,")).toBe("project");
    expect(normalizeTerm("the")).toBeNull();
    expect(normalizeTerm("C++")).toBe("c++");
    expect(termsOf("Project management experience")).toEqual(["project", "management", "experience"]);
    expect(indexTerms("skills skills SKILLS")).toEqual(["skill"]);
  });

  it("ranks the passage that answers the question first", () => {
    const passages = [
      { id: "edu", text: "Education: MBA, Symbiosis Pune, 2014. B.Tech Mechanical, 2011." },
      { id: "exp", text: "Senior Project Manager at Acme Logistics 2019-2023. Managed project budgets and a team of 12." },
      { id: "contact", text: "Email asha@example.test, mobile 9876500000, Pune." },
    ];
    const r = rankPassages("project management experience", passages).sort((a, b) => b.score - a.score);
    expect(r[0]!.id).toBe("exp");
    expect(r.find((x) => x.id === "contact")!.score).toBe(0);
    expect(rankPassages("highest qualification education", passages).sort((a, b) => b.score - a.score)[0]!.id).toBe("edu");
  });

  it("cuts excerpts around the query", () => {
    const text = `${"filler ".repeat(200)}Senior Project Manager at Acme ${"tail ".repeat(200)}`;
    const e = excerptAround(text, "project manager", 120);
    expect(e).toMatch(/Project Manager/);
    expect(e.length).toBeLessThanOrEqual(124);
  });
});
