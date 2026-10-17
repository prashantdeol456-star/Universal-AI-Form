"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, Input, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { GmailStatus, ThreadListItem } from "@/server/messaging/gmail";
import type { DraftView, InsightView } from "@/server/messaging/intelligence";
import { DraftEditor, SummaryCard } from "./Shared";
import { startTask, stepResult, waitTask } from "./useTask";

interface ThreadView {
  id: string;
  subject: string | null;
  omitted: number;
  needsReply: boolean;
  replyTo: string[];
  messages: Array<{ ref: string; from: { name: string | null; email: string } | null; date: string | null; body: string; fromMe: boolean; attachments: Array<{ filename: string; size: number }>; hadQuotedText: boolean; truncated: boolean }>;
}

function Setup() {
  return (
    <Card title="Gmail is not set up on this server">
      <p className="text-sm text-gray-700">To connect Gmail, the server owner adds a Google OAuth client (no password is ever used):</p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-gray-700">
        <li>Google Cloud Console → APIs &amp; Services → enable the <b>Gmail API</b>.</li>
        <li>OAuth consent screen → add scopes <code>gmail.readonly</code> and (for drafts) <code>gmail.compose</code>.</li>
        <li>Credentials → OAuth client ID → Web application → redirect URI <code>https://YOUR-DOMAIN/api/integrations/gmail/callback</code>.</li>
        <li>Set <code>GMAIL_OAUTH_CLIENT_ID</code> and <code>GMAIL_OAUTH_CLIENT_SECRET</code> in the server&apos;s environment and restart.</li>
      </ol>
    </Card>
  );
}

export function GmailPanel({ status, notice, jobs }: { status: GmailStatus; notice: string | null; jobs: Array<{ id: string; title: string }> }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "red" | "green" | "amber" | "blue"; text: string } | null>(notice ? { tone: notice.startsWith("Connected") ? "green" : "red", text: notice } : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [insights, setInsights] = useState<InsightView[]>([]);
  const [draft, setDraft] = useState<{ d: DraftView; taskId: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [tone, setTone] = useState("professional");
  const [jobId, setJobId] = useState("");

  if (!status.configured) return <Setup />;

  async function connect(access: "read" | "read_draft") {
    setBusy("connect");
    const r = await api<{ url: string }>("/api/integrations/gmail/connect", { body: { access } });
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "red", text: r.error.message });
    window.location.href = r.data.url;
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Gmail? Access is revoked at Google, and summaries and local drafts from Gmail are deleted here. Drafts already in your Gmail stay there.")) return;
    const r = await api<{ revokedAtGoogle: boolean }>("/api/integrations/gmail/disconnect", { method: "POST" });
    setMsg(r.ok ? { tone: "green", text: r.data.revokedAtGoogle ? "Disconnected and access revoked at Google." : "Disconnected. Google did not confirm the revocation; you can also remove the app at myaccount.google.com/permissions." } : { tone: "red", text: r.error.message });
    router.refresh();
  }

  async function toggleCloud(allowed: boolean) {
    if (allowed && !window.confirm("Allow cloud AI (Google Gemini) to read the messages of a conversation when YOU ask for a summary or a draft? Only that conversation is sent, never your whole mailbox. You can switch this off any time.")) return;
    const r = await api("/api/integrations/gmail", { method: "PATCH", body: { cloudAiAllowed: allowed } });
    if (!r.ok) setMsg({ tone: "red", text: r.error.message });
    router.refresh();
  }

  async function search(e?: FormEvent<HTMLFormElement>, pageToken?: string) {
    e?.preventDefault();
    const q = e ? Object.fromEntries([...new FormData(e.currentTarget)].filter(([, v]) => String(v).trim()).map(([k, v]) => [k, String(v)])) : query;
    setQuery(q);
    setBusy("search");
    const params = new URLSearchParams({ ...q, ...(pageToken ? { pageToken } : {}) });
    const r = await api<{ threads: ThreadListItem[]; nextPageToken: string | null }>(`/api/mail/threads?${params}`);
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "red", text: r.error.message });
    setThreads(pageToken ? [...(threads ?? []), ...r.data.threads] : r.data.threads);
    setNext(r.data.nextPageToken);
  }

  async function open(id: string) {
    setBusy(id);
    setDraft(null);
    const [t, ins] = await Promise.all([api<ThreadView>(`/api/mail/threads/${id}`), api<{ insights: InsightView[] }>(`/api/messages/insights?source=gmail&ref=${id}`)]);
    setBusy(null);
    if (!t.ok) return setMsg({ tone: "red", text: t.error.message });
    setThread(t.data);
    setInsights(ins.ok ? ins.data.insights : []);
  }

  async function summarise() {
    if (!thread) return;
    setBusy("summary");
    const s = await startTask("summarize_email_thread", { threadId: thread.id });
    if (!s.ok) return setBusy(null), setMsg({ tone: "red", text: s.error });
    const v = await waitTask(s.id);
    setBusy(null);
    if (v?.task.status !== "completed") return setMsg({ tone: "red", text: v?.steps.find((x) => x.error_message)?.error_message ?? "The summary could not be made" });
    const ins = await api<{ insights: InsightView[] }>(`/api/messages/insights?source=gmail&ref=${thread.id}`);
    if (ins.ok) setInsights(ins.data.insights);
  }

  async function makeDraft() {
    if (!thread) return;
    setBusy("draft");
    const s = await startTask("draft_email_reply", { threadId: thread.id, instruction: instruction.trim() || null, tone, jobId: jobId || null });
    if (!s.ok) return setBusy(null), setMsg({ tone: "red", text: s.error });
    const v = await waitTask(s.id);
    setBusy(null);
    const draftId = stepResult(v, "draft")?.draftId as string | undefined;
    if (!draftId) return setMsg({ tone: "red", text: v?.steps.find((x) => x.error_message)?.error_message ?? "The draft could not be written" });
    const d = await api<DraftView>(`/api/messages/drafts/${draftId}`);
    if (d.ok) setDraft({ d: d.data, taskId: s.id });
  }

  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card title="Gmail">
        {!status.connected ? (
          <div className="space-y-2 text-sm text-gray-700">
            {status.status === "revoked" && <Alert tone="amber">Gmail access was revoked or expired. Connect again.</Alert>}
            <p>Connect with Google&apos;s own sign-in. Nothing is read until you search or open a conversation. Messages are never stored here; only summaries and drafts you ask for.</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy !== null} onClick={() => void connect("read")}>
                Connect (read only)
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={() => void connect("read_draft")}>
                Connect (read + create drafts)
              </Button>
            </div>
            <p className="text-xs text-gray-500">“Create drafts” uses Google&apos;s gmail.compose permission. Google bundles sending into that permission; this app has no send function and never sends.</p>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="green">Connected</Badge> <b>{status.account}</b>
              <Badge tone="gray">{status.canCreateDrafts ? "read + drafts" : "read only"}</Badge>
              <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
                Disconnect
              </Button>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={status.cloudAiAllowed} onChange={(e) => void toggleCloud(e.target.checked)} />
              <span>
                Allow cloud AI for conversations I choose to summarise or answer
                <span className="block text-xs text-gray-500">Off by default. When off, a self-hosted model is used if configured; otherwise no AI.</span>
              </span>
            </label>
          </div>
        )}
      </Card>

      {status.connected && (
        <>
          <Card title="Search">
            <form onSubmit={(e) => void search(e)} className="grid gap-2 sm:grid-cols-3">
              <Input name="text" placeholder="Words" maxLength={100} aria-label="Words" />
              <Input name="from" placeholder="From (e.g. recruiter)" maxLength={100} aria-label="From" />
              <Input name="subject" placeholder="Subject" maxLength={100} aria-label="Subject" />
              <Input name="after" type="date" aria-label="After" />
              <Input name="before" type="date" aria-label="Before" />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="unread" value="true" /> Unread only
              </label>
              <div className="sm:col-span-3">
                <Button type="submit" disabled={busy !== null}>
                  {busy === "search" ? "Searching…" : "Search Gmail"}
                </Button>
                <span className="ml-2 text-xs text-gray-500">Spam and trash are never searched; up to 20 conversations per page.</span>
              </div>
            </form>
            {threads && threads.length === 0 && <p className="mt-2 text-sm text-gray-500">No conversations found.</p>}
            {threads && threads.length > 0 && (
              <ul className="mt-3 divide-y divide-gray-100">
                {threads.map((t) => (
                  <li key={t.id}>
                    <button className="w-full py-2 text-left hover:bg-gray-50" onClick={() => void open(t.id)}>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <b className={t.unread ? "text-gray-900" : "text-gray-700"}>{t.subject ?? "(no subject)"}</b>
                        {t.needsReply && <Badge tone="amber">Waiting for your reply</Badge>}
                        {t.unread && <Badge tone="blue">Unread</Badge>}
                      </div>
                      <div className="text-xs text-gray-500">
                        {t.from} · {t.messageCount} message(s) · last from {t.lastFrom} {t.date ? `· ${new Date(t.date).toLocaleString("en-IN")}` : ""}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {next && (
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void search(undefined, next)}>
                More
              </Button>
            )}
          </Card>

          {thread && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title={thread.subject ?? "(no subject)"}>
                {thread.omitted > 0 && <p className="text-xs text-gray-500">{thread.omitted} older message(s) not shown.</p>}
                <ol className="space-y-3">
                  {thread.messages.map((m) => (
                    <li key={m.ref} className={`rounded-lg border p-2 text-sm ${m.fromMe ? "border-brand-100 bg-brand-50/40" : "border-gray-200"}`}>
                      <div className="text-xs text-gray-500">
                        <b>{m.ref}</b> · {m.fromMe ? "You" : m.from?.name ?? m.from?.email} {m.date ? `· ${new Date(m.date).toLocaleString("en-IN")}` : ""}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-gray-800">{m.body}</p>
                      {m.attachments.length > 0 && <p className="mt-1 text-xs text-gray-500">Attachments (not opened): {m.attachments.map((a) => a.filename).join(", ")}</p>}
                      {m.hadQuotedText && <p className="text-xs text-gray-400">Quoted earlier text hidden.</p>}
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-xs text-gray-500">Message text is shown as plain text. Links and instructions inside emails are never followed.</p>
              </Card>
              <div className="space-y-4">
                <Card title="Ask the assistant">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void summarise()}>
                      {busy === "summary" ? "Summarising…" : "Summarise + action items"}
                    </Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={600} placeholder="What should the reply say? (e.g. available after 2 pm on Tuesday)" aria-label="Reply instruction" />
                    <div className="flex flex-wrap gap-2">
                      <Select value={tone} onChange={(e) => setTone(e.target.value)} aria-label="Tone">
                        <option value="professional">Professional</option>
                        <option value="formal">Formal</option>
                        <option value="friendly">Friendly</option>
                        <option value="concise">Concise</option>
                      </Select>
                      {jobs.length > 0 && (
                        <Select value={jobId} onChange={(e) => setJobId(e.target.value)} aria-label="Related saved job">
                          <option value="">No related job</option>
                          {jobs.map((j) => (
                            <option key={j.id} value={j.id}>
                              {j.title}
                            </option>
                          ))}
                        </Select>
                      )}
                      <Button size="sm" disabled={busy !== null || !thread.replyTo.length} onClick={() => void makeDraft()}>
                        {busy === "draft" ? "Writing…" : "Draft a reply"}
                      </Button>
                    </div>
                    {thread.replyTo.length > 0 ? <p className="text-xs text-gray-500">A reply would go to: {thread.replyTo.join(", ")}</p> : <p className="text-xs text-gray-500">No message from someone else to reply to.</p>}
                  </div>
                </Card>
                {draft && <DraftEditor key={draft.d.id} initial={draft.d} taskId={draft.taskId} />}
                {insights.map((i) => (
                  <SummaryCard key={i.id} insight={i} onDeleted={() => setInsights((x) => x.filter((y) => y.id !== i.id))} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
