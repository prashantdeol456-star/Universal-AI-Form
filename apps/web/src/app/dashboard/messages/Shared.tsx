"use client";

import { useState } from "react";
import { Alert, Badge, Button, Card, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { DraftView, InsightView } from "@/server/messaging/intelligence";
import { waitTask, type TaskView } from "./useTask";

export const ENGINE_TEXT: Record<string, string> = {
  local: "Written by the self-hosted AI model",
  gemini: "Written by Google Gemini (cloud) — this conversation is allowed for cloud AI",
  rules: "No AI was used",
};
export const REASON_TEXT: Record<string, string> = {
  cloud_not_allowed_for_this_conversation: "Cloud AI is not allowed for this conversation (you can allow it above). No message text was sent anywhere.",
  no_consent: "Cloud AI is switched off in your settings.",
  local_only: "This server uses local AI only and no local model is configured.",
  not_configured: "No AI model is configured on this server.",
  over_budget: "Today's AI limit is used up.",
  provider_error: "The AI model did not answer.",
  invalid_model_output: "The AI reply could not be checked against the messages, so it was discarded.",
};

export function SummaryCard({ insight, onDeleted }: { insight: InsightView; onDeleted: () => void }) {
  async function del() {
    const r = await api(`/api/messages/insights/${insight.id}`, { method: "DELETE" });
    if (r.ok) onDeleted();
  }
  return (
    <Card title="Summary" actions={<Button size="sm" variant="ghost" onClick={() => void del()}>Delete summary</Button>}>
      <p className="text-xs text-gray-500">
        {ENGINE_TEXT[insight.engine.provider]}
        {insight.engine.reason ? ` — ${REASON_TEXT[insight.engine.reason] ?? insight.engine.reason}` : ""} · {new Date(insight.createdAt).toLocaleString("en-IN")}
      </p>
      <p className="mt-2 text-sm text-gray-900">{insight.summary}</p>
      {insight.needsReply && <Badge tone="amber">Waiting for your reply</Badge>}
      {insight.actionItems.length > 0 && (
        <div className="mt-3 text-sm">
          <div className="text-xs font-semibold text-gray-700">Suggested action items (check them; nothing is added anywhere)</div>
          <ul className="list-disc pl-5">
            {insight.actionItems.map((a, i) => (
              <li key={i}>
                {a.text}
                {a.due ? <Badge tone="blue">{a.due}</Badge> : null} <span className="text-xs text-gray-500">[{a.ref}: “{a.quote}”]</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {insight.questions.length > 0 && (
        <div className="mt-3 text-sm">
          <div className="text-xs font-semibold text-gray-700">Questions asked of you</div>
          <ul className="list-disc pl-5">
            {insight.questions.map((q, i) => (
              <li key={i}>
                {q.text} <span className="text-xs text-gray-500">[{q.ref}]</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/**
 * The reply draft: recipients are shown and cannot be edited (they come from the thread);
 * the text is editable until it is approved. Gmail: "Create as Gmail draft" approves the
 * exact current text; nothing is sent. WhatsApp: copy into WhatsApp yourself.
 */
export function DraftEditor({ initial, taskId, onChange }: { initial: DraftView; taskId: string | null; onChange?: (d: DraftView) => void }) {
  const [d, setD] = useState(initial);
  const [body, setBody] = useState(initial.body);
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [msg, setMsg] = useState<{ tone: "red" | "green" | "amber"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = body !== d.body || (d.channel === "gmail" && subject !== (d.subject ?? ""));
  const editable = d.status === "draft";

  const update = (next: DraftView) => {
    setD(next);
    onChange?.(next);
  };

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    const r = await api<DraftView>(`/api/messages/drafts/${d.id}`, { method: "PATCH", body: d.channel === "gmail" ? { body, subject } : { body } });
    if (!r.ok) {
      setMsg({ tone: "red", text: r.error.message });
      return false;
    }
    update({ ...r.data, meta: d.meta });
    return true;
  }

  async function approveGmail() {
    if (!taskId) return;
    if (!window.confirm(`Create this reply as a DRAFT in your Gmail, to: ${d.recipients.join(", ")}?\n\nIt is NOT sent. You can review and send it from Gmail yourself.`)) return;
    setBusy(true);
    if (!(await save())) return setBusy(false);
    const t = await api<TaskView>(`/api/tasks/${taskId}`);
    const pending = t.ok ? t.data.approvals.find((a) => a.status === "pending") : null;
    if (!pending) {
      setBusy(false);
      return setMsg({ tone: "red", text: "There is no approval waiting for this draft. Open it under Tasks." });
    }
    const a = await api(`/api/approvals/${pending.id}`, { body: { decision: "approve" } });
    if (!a.ok) {
      setBusy(false);
      return setMsg({ tone: "red", text: a.error.message });
    }
    const done = await waitTask(taskId, (v) => v.task.status === "completed" || v.task.status === "failed");
    setBusy(false);
    const r = await api<DraftView>(`/api/messages/drafts/${d.id}`);
    if (r.ok) update({ ...r.data, meta: d.meta });
    if (done?.task.status === "completed") setMsg({ tone: "green", text: "Created as a draft in your Gmail. It was not sent — open Gmail to review and send it." });
    else if (done?.task.status === "needs_verification" || done?.task.status === "paused") setMsg({ tone: "amber", text: "The result is not certain (connection problem). Check your Gmail drafts before trying again — see Tasks." });
    else setMsg({ tone: "red", text: done?.steps.find((s) => s.error_message)?.error_message ?? "The draft could not be created in Gmail." });
  }

  async function copy() {
    if (!(await save())) return;
    await navigator.clipboard.writeText(body).catch(() => {});
    const r = await api<DraftView>(`/api/messages/drafts/${d.id}`, { method: "PATCH", body: { status: "copied" } });
    if (r.ok) update({ ...r.data, meta: d.meta });
    setMsg({ tone: "green", text: "Copied. Paste it into WhatsApp and send it yourself." });
  }

  async function discard() {
    const r = await api<DraftView>(`/api/messages/drafts/${d.id}`, { method: "PATCH", body: { status: "discarded" } });
    if (r.ok) update({ ...r.data, meta: d.meta });
  }

  const meta = d.meta;
  return (
    <Card title={d.channel === "gmail" ? "Reply draft (email)" : "Reply draft (WhatsApp)"}>
      {meta && (
        <p className="text-xs text-gray-500">
          {ENGINE_TEXT[meta.engine.provider]}
          {meta.engine.reason ? ` — ${REASON_TEXT[meta.engine.reason] ?? meta.engine.reason}` : ""}
          {meta.usedRefs.length ? ` · based on ${meta.usedRefs.join(", ")}` : ""}
        </p>
      )}
      {d.channel === "gmail" && (
        <div className="mt-2 space-y-2 text-sm">
          <div>
            <span className="text-xs text-gray-500">To (from the thread; cannot be changed here): </span>
            <b>{d.recipients.join(", ")}</b> <span className="text-xs text-gray-500">· no Cc / Bcc</span>
          </div>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} maxLength={300} aria-label="Subject" />
        </div>
      )}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} rows={10} maxLength={20000} aria-label="Draft text" className="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
      {meta && meta.unsupported.length > 0 && (
        <Alert tone="amber">Check these details — they are not in the messages, your verified facts or your instruction: {meta.unsupported.join(", ")}</Alert>
      )}
      {meta && meta.missing.length > 0 && <p className="text-xs text-amber-700">Still needed from you: {meta.missing.join("; ")}</p>}
      {meta && meta.facts.length > 0 && (
        <details className="text-xs text-gray-600">
          <summary className="cursor-pointer">Verified facts the AI could use ({meta.facts.length})</summary>
          <ul>{meta.facts.map((f) => <li key={f.ref}>{f.ref} {f.label}: {f.text}</li>)}</ul>
        </details>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge tone={d.status === "created" ? "green" : d.status === "approved" ? "blue" : "gray"}>{d.status === "created" ? "In your Gmail drafts" : d.status}</Badge>
        {editable && dirty && (
          <Button size="sm" variant="secondary" onClick={() => void save()}>
            Save changes
          </Button>
        )}
        {d.channel === "gmail" && editable && (
          <Button size="sm" disabled={busy || !taskId} onClick={() => void approveGmail()}>
            {busy ? "Creating…" : "Approve: create as Gmail draft"}
          </Button>
        )}
        {d.channel === "whatsapp" && d.status !== "discarded" && (
          <Button size="sm" onClick={() => void copy()}>
            Copy for WhatsApp
          </Button>
        )}
        {editable && (
          <Button size="sm" variant="ghost" onClick={() => void discard()}>
            Discard
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">{d.channel === "gmail" ? "Nothing is ever sent from here. A Gmail draft is created only after you approve, and you send it from Gmail." : "Imported chats have no sending channel: you paste and send the reply in WhatsApp yourself."}</p>
      {msg && <div className="mt-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
    </Card>
  );
}
