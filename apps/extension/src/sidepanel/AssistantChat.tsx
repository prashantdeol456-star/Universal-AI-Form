import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * The assistant chat under the form: what the agent is doing (real steps only),
 * its questions, and anything the user wants it to learn ("meri city Noida hai").
 */
export interface ChatMsg {
  id: number;
  role: "user" | "assistant" | "log";
  text: string;
  tone?: "ok" | "warn";
  actions?: Array<{ id: string; label: string }>;
}

export function AssistantChat({
  messages,
  running,
  waiting,
  onSend,
  onAction,
  onStop,
  onFillAll,
}: {
  messages: ChatMsg[];
  running: boolean;
  /** The agent asked a question and waits for the reply. */
  waiting: boolean;
  onSend: (text: string) => void;
  onAction: (id: string) => void;
  onStop: () => void;
  onFillAll: () => void;
}) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer Chrome returns a Promise from scrollIntoView, which React would treat as a cleanup function.
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, running]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    onSend(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const lastActions = [...messages].reverse().find((m) => m.role !== "log")?.actions;

  return (
    <div className="card assistant">
      <div className="row-between">
        <div className="eyebrow">Assistant</div>
        {running ? (
          <button className="secondary small-btn" onClick={onStop}>
            ■ Stop
          </button>
        ) : (
          <button className="primary small-btn" onClick={onFillAll}>
            ✨ Fill everything
          </button>
        )}
      </div>
      {messages.length === 0 && (
        <p className="muted small" style={{ margin: 0 }}>
          Press <b>Fill everything</b> (or type “fill”) and I will read this page, attach your CV, fill what I know, ask you what I don’t, and
          remember your answers for next time. Paste a link to open a page first. Tell me anything about yourself and I save it to your profile.
          You do CAPTCHA, “I agree” and Submit yourself.
        </p>
      )}
      <div className="assistant-log">
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="bubble-user">
              {m.text}
            </div>
          ) : m.role === "log" ? (
            <div key={m.id} className={`log-line ${m.tone ?? ""}`}>
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={`bubble-ai-text ${m.tone ?? ""}`}>
              {m.text}
            </div>
          ),
        )}
        {running && !waiting && (
          <div className="bubble-typing" aria-label="Working">
            <span />
            <span />
            <span />
          </div>
        )}
        <div ref={endRef} />
      </div>
      {waiting && lastActions?.length ? (
        <div className="row-actions">
          {lastActions.map((a) => (
            <button key={a.id} className={a.id.startsWith("__no") ? "secondary" : "primary"} onClick={() => onAction(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer-row">
        <textarea
          rows={2}
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={waiting ? "Type your answer… (or “skip”)" : "e.g. “fill”, a link to open, or “meri current city Noida hai”"}
          aria-label="Message to the assistant"
        />
        <button className="primary send" onClick={send} disabled={!text.trim()} aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
