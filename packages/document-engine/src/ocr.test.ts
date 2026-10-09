import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { extractFields } from "./extract";
import { detectFileType } from "./fileType";
import { extractText, imageInfo, shutdownOcr } from "./ocr";

/** Renders a synthetic "document" image so the real OCR pipeline is exercised offline. */
async function renderDoc(lines: string[]): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="${120 + lines.length * 70}">
    <rect width="100%" height="100%" fill="white"/>
    ${lines.map((l, i) => `<text x="60" y="${100 + i * 70}" font-family="Arial, Helvetica, sans-serif" font-size="40" fill="black">${l}</text>`).join("")}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

afterAll(async () => {
  await shutdownOcr();
});

describe("OCR pipeline (Tesseract, offline language data)", () => {
  it("reads a marksheet image and extracts fields from it", { timeout: 120_000 }, async () => {
    const img = await renderDoc([
      "CENTRAL BOARD OF SECONDARY EDUCATION",
      "SECONDARY SCHOOL EXAMINATION, 2017",
      "Roll No. 4123456",
      "Name of Candidate: ASHA VERMA",
      "Date of Birth: 15/05/2001",
      "Grand Total 438 / 500",
    ]);
    const type = detectFileType(img)!;
    expect(type.kind).toBe("image");
    expect(await imageInfo(img)).toMatchObject({ width: 1400 });

    const res = await extractText(img, type);
    expect(res.engine).toBe("tesseract");
    expect(res.text).toMatch(/ASHA VERMA/);

    const { candidates } = await extractFields("class_10_marksheet", res.text);
    const get = (k: string) => candidates.find((c) => c.fieldKey === k)?.value;
    expect(get("education.class_10.roll_number")).toBe("4123456");
    expect(get("personal.date_of_birth")).toBe("2001-05-15");
    expect(get("education.class_10.percentage")).toBe("87.6");
  });
});
