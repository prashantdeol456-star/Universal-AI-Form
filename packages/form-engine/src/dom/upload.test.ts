// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { acceptsFile, suggestDocumentType } from "../documents";
import { attachFile, listUploadFields } from "./upload";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("upload fields", () => {
  it("finds a hidden file input behind a Workday-style drop zone and describes it", () => {
    document.body.innerHTML = `
      <section>
        <h2>Autofill with Resume</h2>
        <p>Upload either DOC, DOCX, HTML, PDF, or TXT file types (5MB max)</p>
        <div class="dropzone">Drop file here or <button type="button">Select file</button>
          <input type="file" data-automation-id="file-upload-input-ref" accept=".doc,.docx,.html,.pdf,.txt" style="display:none">
        </div>
      </section>
      <label for="ph">Passport size photograph</label><input id="ph" type="file" accept="image/*">`;
    const fields = listUploadFields(document);
    expect(fields).toHaveLength(2);
    expect(fields[0]!.label).toMatch(/Autofill with Resume/);
    expect(fields[0]!.suggested).toBe("resume");
    expect(fields[0]!.accept).toBe(".doc,.docx,.html,.pdf,.txt");
    expect(fields[1]!.suggested).toBe("photograph");
  });

  it("attaches a file the page accepts and fires change; refuses the wrong type", () => {
    document.body.innerHTML = `<h2>Upload your CV</h2><input type="file" accept=".pdf,.docx">`;
    const [f] = listUploadFields(document);
    let changed = 0;
    document.querySelector("input")!.addEventListener("change", () => changed++);
    const wrong = attachFile(document, f!.id, new File(["x"], "photo.png", { type: "image/png" }));
    expect(wrong).toEqual({ ok: false, reason: "not_accepted" });
    const r = attachFile(document, f!.id, new File(["%PDF-1.4"], "Asha Verma CV.pdf", { type: "application/pdf" }));
    expect(r).toEqual({ ok: true, fileName: "Asha Verma CV.pdf" });
    expect(document.querySelector("input")!.files?.[0]?.name).toBe("Asha Verma CV.pdf");
    expect(changed).toBe(1);
    expect(attachFile(document, "99", new File(["x"], "a.pdf", { type: "application/pdf" }))).toEqual({ ok: false, reason: "not_found" });
  });

  it("matches accept lists and suggests document types", () => {
    expect(acceptsFile(null, "a.pdf", "application/pdf")).toBe(true);
    expect(acceptsFile("image/*", "a.jpg", "image/jpeg")).toBe(true);
    expect(acceptsFile("application/pdf", "a.jpg", "image/jpeg")).toBe(false);
    expect(suggestDocumentType("Upload Signature (JPG, 20 KB)")).toBe("signature");
    expect(suggestDocumentType("10th Marksheet")).toBe("class_10_marksheet");
    expect(suggestDocumentType("Cover letter")).toBeNull();
  });
});
