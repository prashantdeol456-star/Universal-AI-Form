import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { composeEmail, type ComposeLanguage, type ComposeResult, type ComposeTone } from "./api";
import { getActiveTab, insertEmailIntoTab, isSupportedUrl, undoEmailInTab } from "./page";
import { authorizeSite, decide } from "./siteAccess";

/**
 * "Write email": a chat where the user says what email they need; the server
 * drafts it from their profile (AI or template). The user edits it, inserts it
 * into Gmail / Outlook / the text box they clicked, attaches files and presses
 * Send themselves — nothing is ever sent from here.
 */

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; draft: ComposeResult; subject: string; body: string; inserted: InsertState | null };

type InsertState = { tabId: number; text: string; ok: boolean; canAllow?: string };

const SUGGESTIONS = [
  { label: "Job application", text: "Write a job application email for the post of [position] at [company]. My CV is attached." },
  { label: "Follow-up", text: "Write a polite follow-up email asking about the status of my job application." },
  { label: "Leave request", text: "Write a leave application for [number] days from [date] because of [reason]." },
  { label: "Thank you", text: "Write a short thank-you email after my interview today." },
];

let nextId = 1;

export function Compose({ server }: { server: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [tone, setTone] = useState<ComposeTone>("formal");
  const [language, setLanguage] = useState<ComposeLanguage>("en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  const lastDraft = [...messages].reverse().find((m): m is Extract<Message, { role: "assistant" }> => m.role === "assistant");

  async function send(text = input) {
    const instruction = text.trim();
    if (instruction.length < 3 || busy) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { id: nextId++, role: "user", text: instruction }]);
    setBusy(true);
    try {
      const draft = await composeEmail({ instruction, tone, language, previous: lastDraft?.draft.template ?? null });
      setMessages((m) => [...m, { id: nextId++, role: "assistant", draft, subject: draft.subject, body: draft.body, inserted: null }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function update(id: number, patch: Partial<Extract<Message, { role: "assistant" }>>) {
    setMessages((list) => list.map((m) => (m.id === id && m.role === "assistant" ? { ...m, ...patch } : m)));
  }

  async function insert(msg: Extract<Message, { role: "assistant" }>) {
    const tab = await getActiveTab();
    if (!tab || !isSupportedUrl(tab.url)) {
      update(msg.id, { inserted: { tabId: -1, ok: false, text: "Open Gmail or Outlook in this tab, click Compose, then press Insert again." } });
      return;
    }
    // Least privilege: text is only inserted on sites the user allowed for it.
    const d = await decide("insert_text", tab.url).catch((e: unknown) => ({ allowed: false as const, fix: "invalid_url" as const, reason: e instanceof Error ? e.message : String(e) }));
    if (!d.allowed) {
      update(msg.id, { inserted: { tabId: tab.id, ok: false, text: d.reason, canAllow: d.fix === "authorize_site" ? tab.url ?? undefined : undefined } });
      return;
    }
    const r = await insertEmailIntoTab(tab.id, { subject: msg.subject, body: msg.body });
    if (!r.ok) {
      update(msg.id, { inserted: { tabId: tab.id, ok: false, text: r.error, canAllow: tab.url ?? undefined } });
      return;
    }
    const where = r.result.target === "gmail" ? "Gmail" : r.result.target === "outlook" ? "Outlook" : "the text box";
    if (r.result.body === "not_found") {
      update(msg.id, { inserted: { tabId: tab.id, ok: false, text: "No email box found. Click Compose (or click inside the message box), then press Insert again." } });
      return;
    }
    const subjectNote = r.result.subject === "filled" ? " Subject added." : r.result.subject === "kept" ? " Your existing subject was kept." : " Add a subject yourself.";
    update(msg.id, { inserted: { tabId: tab.id, ok: true, text: `Inserted into ${where}.${subjectNote} Check it, attach your CV if needed, and press Send yourself.` } });
  }

  async function undo(msg: Extract<Message, { role: "assistant" }>) {
    if (!msg.inserted) return;
    const r = await undoEmailInTab(msg.inserted.tabId);
    update(msg.id, { inserted: { ...msg.inserted, ok: false, text: r.ok ? "Removed from the email." : r.error } });
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="compose">
      <div className="compose-scroll pad stack">
        {messages.length === 0 && (
          <div className="card">
            <div className="eyebrow">Write email</div>
            <p className="small" style={{ margin: 0 }}>
              Tell me what email you need, in English, Hindi or Hinglish. I write it from your profile (name, education, skills, contact). You check it,
              insert it into Gmail or Outlook, attach your CV and press <b>Send</b> yourself.
            </p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} className="chip" onClick={() => setInput(s.text)}>
                  {s.label}
                </button>
              ))}
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Tip: add <b>Key Skills</b> and <b>Professional Summary</b> in your profile (or upload your CV) for better emails.
            </p>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="bubble-user">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="card bubble-ai">
              <div className="row-between">
                <span className={`badge ${m.draft.source === "gemini" ? "ask" : ""}`}>{m.draft.source === "gemini" ? "AI draft" : "Template"}</span>
                <span className="muted small">Edit anything below</span>
              </div>
              {m.draft.notice && <div className="warn small">{m.draft.notice}</div>}
              <label className="small muted" htmlFor={`s${m.id}`}>
                Subject
              </label>
              <input id={`s${m.id}`} className="full" value={m.subject} onChange={(e) => update(m.id, { subject: e.target.value })} />
              <textarea className="full mail-body" rows={12} value={m.body} onChange={(e) => update(m.id, { body: e.target.value })} aria-label="Email text" />
              {m.draft.missing.length > 0 && (
                <div className="small">
                  <span className="muted">Not in your profile yet (shown in [brackets]): </span>
                  {m.draft.missing.map((x) => x.label).join(", ")}.{" "}
                  <button className="link small" onClick={() => chrome.tabs.create({ url: `${server}/dashboard/profile` })}>
                    Add to profile
                  </button>
                </div>
              )}
              <div className="row-actions">
                <button className="primary" onClick={() => void insert(m)}>
                  Insert into email
                </button>
                <button
                  className="secondary"
                  onClick={() => void navigator.clipboard.writeText(`${m.subject}\n\n${m.body}`).then(() => update(m.id, { inserted: { tabId: -1, ok: true, text: "Copied. Paste it into your email." } }))}
                >
                  Copy
                </button>
                {m.inserted?.ok && m.inserted.tabId > 0 && (
                  <button className="link small" onClick={() => void undo(m)}>
                    Undo insert
                  </button>
                )}
              </div>
              {m.inserted && <div className={m.inserted.ok ? "info small" : "alert"}>{m.inserted.text}</div>}
              {m.inserted && !m.inserted.ok && m.inserted.canAllow && (
                <button
                  className="link small"
                  onClick={async () => {
                    const a = await authorizeSite(m.inserted!.canAllow!, ["insert_text"]);
                    if (a.ok) void insert(m);
                    else update(m.id, { inserted: { ...m.inserted!, text: a.error } });
                  }}
                >
                  Allow inserting text on this site and try again
                </button>
              )}
            </div>
          ),
        )}

        {busy && (
          <div className="bubble-typing" aria-label="Writing">
            <span />
            <span />
            <span />
          </div>
        )}
        {error && <div className="alert">{error}</div>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="composer-options">
          <select value={tone} onChange={(e) => setTone(e.target.value as ComposeTone)} aria-label="Tone">
            <option value="formal">Formal</option>
            <option value="friendly">Friendly</option>
          </select>
          <select value={language} onChange={(e) => setLanguage(e.target.value as ComposeLanguage)} aria-label="Language">
            <option value="en">English</option>
            <option value="hi">हिन्दी</option>
            <option value="hinglish">Hinglish</option>
          </select>
          {messages.length > 0 && (
            <button
              className="link small"
              onClick={() => {
                setMessages([]);
                setError(null);
              }}
            >
              New email
            </button>
          )}
        </div>
        <div className="composer-row">
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            maxLength={1000}
            placeholder={lastDraft ? "Ask for a change, e.g. “make it shorter” or “mention 2 years in Tally”" : "e.g. HR ko Accountant post ke liye job application mail likho"}
            aria-label="What email do you need?"
          />
          <button className="primary send" onClick={() => void send()} disabled={busy || input.trim().length < 3} aria-label="Write">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Your details are filled in on our server; the AI only sees your request. Nothing is sent for you.
        </p>
      </div>
    </div>
  );
}
