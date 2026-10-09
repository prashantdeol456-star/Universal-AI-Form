"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Alert, Badge, Button } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { ChatMessageView, ChatProposalView, ChatSessionDetail, ChatSessionSummary, SendMessageResult } from "@/server/chat/types";

const EXAMPLES = [
  "My father's name is Raj Kumar",
  "I completed B.Com in 2022 with 72%",
  "I have 3 years of experience",
  "I am not an ex-serviceman",
  "Mere papa ka naam Raj Kumar hai",
  "मेरी माता का नाम सुनीता देवी है",
  "What do you know about me?",
];

export function ChatAssistant({ sessions, initial }: { sessions: ChatSessionSummary[]; initial: ChatSessionDetail | null }) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(initial?.id ?? null);
  const [messages, setMessages] = useState<ChatMessageView[]>(initial?.messages ?? []);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    const optimistic: ChatMessageView = { id: `tmp-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString(), proposals: [] };
    setMessages((m) => [...m, optimistic]);
    setDraft("");
    const res = await api<SendMessageResult>("/api/chat/messages", { body: { sessionId, content } });
    setSending(false);
    if (!res.ok) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setDraft(content);
      return setError(res.error.message);
    }
    // Server copy replaces the optimistic one (sensitive numbers come back masked).
    setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), ...res.data.messages]);
    if (!sessionId) {
      setSessionId(res.data.sessionId);
      router.replace(`/dashboard/assistant?s=${res.data.sessionId}`, { scroll: false });
      router.refresh();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  function updateProposal(p: ChatProposalView) {
    setMessages((ms) => ms.map((m) => ({ ...m, proposals: m.proposals.map((x) => (x.id === p.id ? p : x)) })));
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this conversation? Values you already saved stay in your profile.")) return;
    const res = await api(`/api/chat/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) return setError(res.error.message);
    if (id === sessionId) router.replace("/dashboard/assistant");
    router.refresh();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="rounded-xl border border-gray-200 bg-white p-2 lg:self-start">
        <Link href="/dashboard/assistant?s=new" className="block rounded-lg bg-brand-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-brand-700">
          New conversation
        </Link>
        <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto lg:max-h-[60vh]">
          {sessions.map((s) => (
            <li key={s.id} className="group flex items-center gap-1">
              <Link
                href={`/dashboard/assistant?s=${s.id}`}
                className={`min-w-0 flex-1 truncate rounded-lg px-3 py-1.5 text-sm ${s.id === sessionId ? "bg-brand-50 font-medium text-brand-700" : "text-gray-600 hover:bg-gray-100"}`}
                title={s.title ?? "Conversation"}
              >
                {s.title ?? "Conversation"}
              </Link>
              <button onClick={() => remove(s.id)} className="rounded px-1.5 text-xs text-gray-400 hover:bg-red-50 hover:text-red-600" aria-label={`Delete conversation ${s.title ?? ""}`}>
                ✕
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="px-3 py-2 text-xs text-gray-400">No conversations yet</li>}
        </ul>
      </aside>

      <section className="flex min-h-[60vh] flex-col rounded-xl border border-gray-200 bg-white">
        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5" aria-live="polite">
          {messages.length === 0 && (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-600">Try one of these:</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => send(ex)} className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm text-gray-700 hover:border-brand-300 hover:bg-brand-50">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} onProposal={updateProposal} onError={setError} />
          ))}
          {sending && <div className="text-sm text-gray-400">Thinking…</div>}
          <div ref={endRef} />
        </div>

        {error && <div className="px-4"><Alert>{error}</Alert></div>}
        <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-gray-100 p-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={2000}
            placeholder="e.g. My mother's name is Sunita Devi  ·  मेरी जन्म तिथि 12/05/2001 है"
            aria-label="Message"
            className="min-h-11 flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
          />
          <Button type="submit" disabled={sending || !draft.trim()}>
            Send
          </Button>
        </form>
      </section>
    </div>
  );
}

function Message({ m, onProposal, onError }: { m: ChatMessageView; onProposal: (p: ChatProposalView) => void; onError: (e: string) => void }) {
  const mine = m.role === "user";
  const pendingNew = m.proposals.filter((p) => p.status === "PENDING" && p.kind === "NEW");
  const [busyAll, setBusyAll] = useState(false);

  async function saveAll() {
    setBusyAll(true);
    const res = await api(`/api/chat/replies/${m.id}/accept-all`, { method: "POST" });
    setBusyAll(false);
    if (!res.ok) return onError(res.error.message);
    pendingNew.forEach((p) => onProposal({ ...p, status: "SAVED" }));
  }

  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${mine ? "bg-brand-600 text-white" : "bg-gray-100 text-gray-900"}`}>
        <p className="whitespace-pre-line">{m.content}</p>
        {m.proposals.some((p) => p.status !== "INFO") && (
          <ul className="mt-3 space-y-2">
            {m.proposals
              .filter((p) => p.status !== "INFO")
              .map((p) => (
                <ProposalCard key={p.id} p={p} onChange={onProposal} onError={onError} />
              ))}
          </ul>
        )}
        {pendingNew.length > 1 && (
          <div className="mt-2">
            <Button size="sm" variant="secondary" disabled={busyAll} onClick={saveAll}>
              Save all {pendingNew.length} new values
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProposalCard({ p, onChange, onError }: { p: ChatProposalView; onChange: (p: ChatProposalView) => void; onError: (e: string) => void }) {
  const [busy, setBusy] = useState(false);

  async function act(action: "accept" | "reject") {
    setBusy(true);
    const res = await api<{ proposal: ChatProposalView }>(`/api/chat/proposals/${p.id}`, { body: { action } });
    setBusy(false);
    if (!res.ok) return onError(res.error.message);
    onChange(res.data.proposal);
  }

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-3 text-gray-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-gray-500">
          {p.label} {p.labelHi && <span className="text-gray-400">· {p.labelHi}</span>}
        </span>
        {p.method === "local_ai" && <Badge tone="blue">Local AI</Badge>}
      </div>
      {p.kind === "UPDATE" && p.previousValue !== null ? (
        <div className="mt-1 text-sm">
          <span className="text-gray-400 line-through">{p.previousValue}</span> → <span className="font-semibold">{p.value}</span>
        </div>
      ) : (
        <div className="mt-1 text-sm font-semibold">{p.value}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {p.status === "PENDING" ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => act("accept")}>
              {p.kind === "UPDATE" ? "Yes, update" : "Save"}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("reject")}>
              {p.kind === "UPDATE" ? "Keep current" : "Don't save"}
            </Button>
          </>
        ) : p.status === "SAVED" ? (
          <Badge tone="green">Saved to profile</Badge>
        ) : p.status === "REJECTED" ? (
          <Badge>Not saved</Badge>
        ) : (
          <Badge>Replaced by a newer message</Badge>
        )}
      </div>
    </li>
  );
}
