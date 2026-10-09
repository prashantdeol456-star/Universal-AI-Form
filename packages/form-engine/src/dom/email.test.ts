// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { insertEmailDraft } from "./email";

const draft = { subject: "Application for Accountant – Asha Verma", body: "Dear Sir/Madam,\n\nI am writing to apply.\n\nRegards,\nAsha Verma" };

let sends = 0;
beforeEach(() => {
  sends = 0;
  document.body.innerHTML = "";
});

function gmailCompose(subject = "", existing = "") {
  document.body.innerHTML = `
    <div class="compose">
      <input name="to" aria-label="To recipients">
      <input name="subjectbox" placeholder="Subject" value="${subject}">
      <div aria-label="Message Body" role="textbox" contenteditable="true" g_editable="true">${existing}</div>
      <div role="button" id="send">Send</div>
    </div>`;
  document.getElementById("send")!.addEventListener("click", () => sends++);
}

describe("insertEmailDraft", () => {
  it("fills an empty Gmail compose window and never presses Send", () => {
    gmailCompose();
    const run = insertEmailDraft(document, draft);
    expect(run.result).toEqual({ target: "gmail", body: "inserted", subject: "filled" });
    const body = document.querySelector<HTMLElement>('[g_editable="true"]')!;
    expect(body.textContent).toContain("I am writing to apply.");
    expect(body.children.length).toBe(6); // one div per line, blank lines as <br>
    expect(document.querySelector<HTMLInputElement>('[name="subjectbox"]')!.value).toBe(draft.subject);
    expect(sends).toBe(0);
  });

  it("keeps an existing subject and puts the draft above a signature; undo restores", () => {
    gmailCompose("Re: Interview", "<div>-- my signature</div>");
    const run = insertEmailDraft(document, draft);
    expect(run.result.subject).toBe("kept");
    const body = document.querySelector<HTMLElement>('[g_editable="true"]')!;
    expect(body.firstElementChild!.textContent).toBe("Dear Sir/Madam,");
    expect(body.lastElementChild!.textContent).toBe("-- my signature");
    expect(run.undo()).toBe(true);
    expect(body.innerHTML).toBe("<div>-- my signature</div>");
    expect(document.querySelector<HTMLInputElement>('[name="subjectbox"]')!.value).toBe("Re: Interview");
    expect(run.undo()).toBe(false);
  });

  it("recognises Outlook on the web", () => {
    document.body.innerHTML = `<div><input aria-label="Add a subject"><div aria-label="Message body, press Alt+F10 to exit" contenteditable="true"></div></div>`;
    const run = insertEmailDraft(document, draft);
    expect(run.result).toEqual({ target: "outlook", body: "inserted", subject: "filled" });
  });

  it("falls back to the only text box on the page and restores it on undo", () => {
    document.body.innerHTML = `<form><input name="email_subject"><textarea name="message">old text</textarea><button type="submit">Send</button></form>`;
    document.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      sends++;
    });
    const run = insertEmailDraft(document, draft);
    const area = document.querySelector("textarea")!;
    expect(run.result).toEqual({ target: "field", body: "inserted", subject: "filled" });
    expect(area.value.startsWith("Dear Sir/Madam,")).toBe(true);
    expect(area.value.endsWith("old text")).toBe(true);
    run.undo();
    expect(area.value).toBe("old text");
    expect(sends).toBe(0);
  });

  it("reports when there is no compose box", () => {
    document.body.innerHTML = `<p>Inbox</p><textarea></textarea><textarea></textarea>`;
    expect(insertEmailDraft(document, draft).result).toEqual({ target: null, body: "not_found", subject: "not_found" });
  });
});
