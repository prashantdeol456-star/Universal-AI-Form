"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Alert, Badge, Button, Card, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { DraftView, InsightView } from "@/server/messaging/intelligence";
import type { ChatMessageView, ChatSummaryView, WhatsAppCapabilities } from "@/server/messaging/whatsapp";
import { DraftEditor, SummaryCard } from "./Shared";
import { startTask, stepResult, waitTask } from "./useTask";

interface Preview {
  format: string;
  dateOrder: "dmy" | "mdy";
  messages: number;
  participants: Array<{ name: string; messages: number }>;
  firstDate: string | null;
  lastDate: string | null;
  truncated: boolean;
}

async function upload(path: string, form: FormData) {
  const res = await fetch(path, { method: "POST", body: form, credentials: "same-origin" }).catch(() => null);
  const payload = await res?.json().catch(() => null);
  return res?.ok ? { ok: true as const, data: payload } : { ok: false as const, error: payload?.error?.message ?? "Upload failed" };
}

export function WhatsAppPanel({ caps, chats }: { caps: WhatsAppCapabilities; chats: ChatSummaryView[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [msg, setMsg] = useState<{ tone: "red" | "green" | "amber"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<{ chat: ChatSummaryView; messages: ChatMessageView[] } | null>(null);
  const [insights, setInsights] = useState<InsightView[]>([]);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [instruction, setInstruction] = useState("");
  const [tone, setTone] = useState("friendly");

  async function doPreview() {
    const f = fileRef.current?.files?.[0];
    if (!f) return setMsg({ tone: "red", text: "Choose the exported .txt file" });
    const form = new FormData();
    form.set("file", f);
    setBusy("preview");
    const r = await upload("/api/whatsapp/preview", form);
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "red", text: r.error });
    setMsg(null);
    setPreview(r.data as Preview);
  }

  async function doImport(form: FormData) {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    form.set("file", f);
    setBusy("import");
    const r = await upload("/api/whatsapp/chats", form);
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "red", text: r.error });
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
    setMsg({ tone: "green", text: "Chat imported (encrypted). It is deleted automatically on its expiry date." });
    router.refresh();
  }

  async function openChat(id: string) {
    setBusy(id);
    setDraft(null);
    const [c, ins] = await Promise.all([api<{ chat: ChatSummaryView; messages: ChatMessageView[] }>(`/api/whatsapp/chats/${id}`), api<{ insights: InsightView[] }>(`/api/messages/insights?source=whatsapp&ref=${id}`)]);
    setBusy(null);
    if (!c.ok) return setMsg({ tone: "red", text: c.error.message });
    setOpen(c.data);
    setInsights(ins.ok ? ins.data.insights : []);
  }

  async function patchChat(body: Record<string, unknown>) {
    if (!open) return;
    if (body.cloudAiAllowed === true && !window.confirm("Allow cloud AI (Google Gemini) to read this chat when you ask for a summary or a reply? Messages of other people in it will be sent to Google. You can switch this off any time.")) return;
    const r = await api<ChatSummaryView>(`/api/whatsapp/chats/${open.chat.id}`, { method: "PATCH", body });
    if (!r.ok) return setMsg({ tone: "red", text: r.error.message });
    setOpen({ ...open, chat: r.data });
    router.refresh();
  }

  async function deleteChat() {
    if (!open || !window.confirm("Delete this imported chat, its summaries and drafts? This cannot be undone.")) return;
    const r = await api(`/api/whatsapp/chats/${open.chat.id}`, { method: "DELETE" });
    if (!r.ok) return setMsg({ tone: "red", text: r.error.message });
    setOpen(null);
    setMsg({ tone: "green", text: "Chat and everything made from it deleted." });
    router.refresh();
  }

  async function summarise() {
    if (!open) return;
    setBusy("summary");
    const s = await startTask("summarize_whatsapp_conversation", { chatId: open.chat.id });
    if (!s.ok) return setBusy(null), setMsg({ tone: "red", text: s.error });
    const v = await waitTask(s.id);
    setBusy(null);
    if (v?.task.status !== "completed") return setMsg({ tone: "red", text: v?.steps.find((x) => x.error_message)?.error_message ?? "The summary could not be made" });
    const ins = await api<{ insights: InsightView[] }>(`/api/messages/insights?source=whatsapp&ref=${open.chat.id}`);
    if (ins.ok) setInsights(ins.data.insights);
  }

  async function makeDraft() {
    if (!open) return;
    setBusy("draft");
    const s = await startTask("draft_whatsapp_reply", { chatId: open.chat.id, instruction: instruction.trim() || null, tone });
    if (!s.ok) return setBusy(null), setMsg({ tone: "red", text: s.error });
    const v = await waitTask(s.id);
    setBusy(null);
    const id = stepResult(v, "draft")?.draftId as string | undefined;
    if (!id) return setMsg({ tone: "red", text: v?.steps.find((x) => x.error_message)?.error_message ?? "The draft could not be written" });
    const d = await api<DraftView>(`/api/messages/drafts/${id}`);
    if (d.ok) setDraft(d.data);
  }

  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card title="WhatsApp">
        <ul className="space-y-1 text-sm text-gray-700">
          <li>
            <Badge tone="green">Available</Badge> Personal chats: import a chat you export yourself (WhatsApp → open chat → ⋮ → More → Export chat → <b>Without media</b>).
          </li>
          <li>
            <Badge tone="gray">{caps.businessApi === "not_configured" ? "Not configured" : "Configured, not enabled"}</Badge> WhatsApp Business Platform (business numbers only; it cannot read personal chats). Sending is not built.
          </li>
          <li>
            <Badge tone="gray">Never</Badge> Reading WhatsApp Web, your phone or its backups; sending messages for you.
          </li>
        </ul>
      </Card>

      <Card title="Import a chat export">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="wa-file" hint="(.txt, max 5 MB)">Exported chat</Label>
            <input id="wa-file" ref={fileRef} type="file" accept=".txt,text/plain" className="block text-sm" onChange={() => setPreview(null)} />
          </div>
          <Button variant="secondary" disabled={busy !== null} onClick={() => void doPreview()}>
            {busy === "preview" ? "Reading…" : "Check file"}
          </Button>
        </div>
        {preview && (
          <form
            className="mt-3 grid gap-2 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void doImport(new FormData(e.currentTarget));
            }}
          >
            <p className="text-sm text-gray-700 sm:col-span-2">
              {preview.messages} messages ({preview.format}){preview.firstDate ? ` from ${preview.firstDate.slice(0, 10)} to ${preview.lastDate?.slice(0, 10)}` : ""}
              {preview.truncated ? " — only the first 20 000 were read" : ""}. Nothing is stored until you import.
            </p>
            <div>
              <Label htmlFor="myName">Which name is you?</Label>
              <Select id="myName" name="myName" required defaultValue="">
                <option value="" disabled>
                  Choose…
                </option>
                {preview.participants.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} ({p.messages})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="title" hint="(optional)">Name for this chat</Label>
              <Input id="title" name="title" maxLength={120} />
            </div>
            <div>
              <Label htmlFor="dateOrder">Dates in the file</Label>
              <Select id="dateOrder" name="dateOrder" defaultValue={preview.dateOrder}>
                <option value="dmy">Day/Month/Year</option>
                <option value="mdy">Month/Day/Year</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="retentionDays">Delete automatically after</Label>
              <Select id="retentionDays" name="retentionDays" defaultValue="30">
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy !== null}>
                {busy === "import" ? "Importing…" : "Import (encrypted)"}
              </Button>
              <span className="ml-2 text-xs text-gray-500">The chat contains other people&apos;s messages: import only chats you are part of, and delete them when done.</span>
            </div>
          </form>
        )}
      </Card>

      <Card title={`Imported chats (${chats.length})`}>
        {chats.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {chats.map((c) => (
              <li key={c.id}>
                <button className="w-full py-2 text-left text-sm hover:bg-gray-50" onClick={() => void openChat(c.id)}>
                  <b>{c.title}</b> <span className="text-xs text-gray-500">· {c.messageCount} messages · deleted on {new Date(c.expiresAt).toLocaleDateString("en-IN")}</span>
                  {c.cloudAiAllowed && <Badge tone="amber">Cloud AI allowed</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {open && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card
            title={open.chat.title}
            actions={
              <Button size="sm" variant="ghost" onClick={() => void deleteChat()}>
                Delete chat
              </Button>
            }
          >
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-gray-600">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={open.chat.cloudAiAllowed} onChange={(e) => void patchChat({ cloudAiAllowed: e.target.checked })} /> Allow cloud AI for this chat
              </label>
              <span>You are “{open.chat.myName}”.</span>
            </div>
            <ol className="max-h-[32rem] space-y-1 overflow-y-auto text-sm">
              {open.messages.map((m) => (
                <li key={m.ref} className={m.kind === "system" ? "text-xs text-gray-400" : m.fromMe ? "text-right" : ""}>
                  <span className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-2 py-1 text-left ${m.fromMe ? "bg-brand-50" : m.kind === "system" ? "" : "bg-gray-100"}`}>
                    <span className="block text-[10px] text-gray-500">
                      {m.ref} · {m.fromMe ? "You" : m.sender ?? "WhatsApp"} {m.at ? `· ${new Date(m.at).toLocaleString("en-IN", { timeZone: "UTC" })}` : ""}
                    </span>
                    {m.kind === "media_omitted" ? <i>media not included</i> : m.text}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
          <div className="space-y-4">
            <Card title="Ask the assistant">
              <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void summarise()}>
                {busy === "summary" ? "Summarising…" : "Summarise + pending questions"}
              </Button>
              <div className="mt-3 space-y-2">
                <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={600} placeholder="What should the reply say? (optional)" aria-label="Reply instruction" />
                <div className="flex gap-2">
                  <Select value={tone} onChange={(e) => setTone(e.target.value)} aria-label="Tone">
                    <option value="friendly">Friendly</option>
                    <option value="professional">Professional</option>
                    <option value="concise">Concise</option>
                    <option value="formal">Formal</option>
                  </Select>
                  <Button size="sm" disabled={busy !== null} onClick={() => void makeDraft()}>
                    {busy === "draft" ? "Writing…" : "Draft a reply"}
                  </Button>
                </div>
              </div>
            </Card>
            {draft && <DraftEditor key={draft.id} initial={draft} taskId={null} />}
            {insights.map((i) => (
              <SummaryCard key={i.id} insight={i} onDeleted={() => setInsights((x) => x.filter((y) => y.id !== i.id))} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
