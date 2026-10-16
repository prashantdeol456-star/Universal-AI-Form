import { crc32, deflateRawSync } from "node:zlib";

/**
 * Synthetic documents for tests (no real personal documents anywhere in the repo):
 * a minimal multi-page PDF with a text layer, and ZIP / DOCX archives built in memory.
 */

/** A valid PDF whose page N shows the lines in pages[N-1] (Helvetica, text layer). */
export function makePdf(pages: string[][]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((lines, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    pageIds.push(pageId);
    const ops = lines.map((l, j) => `${j === 0 ? "" : "0 -18 Td "}(${esc(l)}) Tj`).join("\n");
    const stream = `BT /F1 12 Tf 72 740 Td\n${ops}\nET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A ZIP archive (deflate) with the given entries; `fakeSize` lets a test lie about an entry's unpacked size. */
export function makeZip(entries: Array<{ name: string; data: string | Buffer; fakeSize?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const comp = deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(raw);
    const size = e.fakeSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A .docx with paragraphs; "# Title" lines become Heading1, rows (string[]) become a table. */
export function makeDocx(blocks: Array<string | string[]>, opts: { macro?: boolean } = {}): Buffer {
  const body = blocks
    .map((b) => {
      if (Array.isArray(b)) return `<w:tbl><w:tr>${b.map((c) => `<w:tc><w:p><w:r><w:t>${xmlEsc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr></w:tbl>`;
      const h = /^#\s+/.test(b);
      const text = b.replace(/^#\s+/, "");
      return `<w:p>${h ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ""}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
    })
    .join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const types = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.${opts.macro ? "ms-word.document.macroEnabled.main+xml" : "openxmlformats-officedocument.wordprocessingml.document.main+xml"}"/></Types>`;
  const entries: Array<{ name: string; data: string | Buffer }> = [
    { name: "[Content_Types].xml", data: types },
    { name: "word/document.xml", data: doc },
  ];
  if (opts.macro) entries.push({ name: "word/vbaProject.bin", data: Buffer.from([1, 2, 3, 4]) });
  return makeZip(entries);
}
