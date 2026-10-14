"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { TaskStatus } from "@ufa/shared/tasks";
import { Alert, Button, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";

const LANGUAGES = [
  ["en", "English"],
  ["hi", "हिन्दी"],
  ["hinglish", "Hinglish"],
] as const;

/** New task: the two task types that run fully on the server today. */
export function NewTaskForm() {
  const router = useRouter();
  const [type, setType] = useState<"draft_email" | "draft_answers">("draft_email");
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const [tone, setTone] = useState<"formal" | "friendly">("formal");
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number][0]>("en");
  const [questions, setQuestions] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per form: a double click or a retried request does not create two tasks.
  const [idempotencyKey, setKey] = useState(() => crypto.randomUUID());

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const input =
          type === "draft_email"
            ? { instruction, tone, language }
            : { questions: questions.split("\n").map((q) => q.trim()).filter(Boolean), role: role.trim() || null };
        const r = await api<{ task: { id: string } }>("/api/tasks", { body: { taskType: type, title: title.trim() || null, input, idempotencyKey } });
        setBusy(false);
        if (!r.ok) return setError(r.error.message);
        setKey(crypto.randomUUID());
        router.push(`/dashboard/tasks/${r.data.task.id}`);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="t-type">Task</Label>
          <Select id="t-type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="draft_email">Draft an email</option>
            <option value="draft_answers">Draft answers to application questions</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="t-title" hint="(optional)">
            Title
          </Label>
          <Input id="t-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </div>
      </div>
      {type === "draft_email" ? (
        <>
          <div>
            <Label htmlFor="t-instr">What should the email say?</Label>
            <textarea
              id="t-instr"
              required
              minLength={3}
              maxLength={1000}
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. Follow up with HR about my Accountant application"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="t-tone">Tone</Label>
              <Select id="t-tone" value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
                <option value="formal">Formal</option>
                <option value="friendly">Friendly</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="t-lang">Language</Label>
              <Select id="t-lang" value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
                {LANGUAGES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </>
      ) : (
        <>
          <div>
            <Label htmlFor="t-q" hint="(one per line, up to 10)">
              Questions
            </Label>
            <textarea
              id="t-q"
              required
              rows={4}
              value={questions}
              onChange={(e) => setQuestions(e.target.value)}
              placeholder={"Why do you want to join us?\nDescribe your experience with AI products."}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
            />
          </div>
          <div>
            <Label htmlFor="t-role" hint="(optional)">
              Role you are applying for
            </Label>
            <Input id="t-role" value={role} onChange={(e) => setRole(e.target.value)} maxLength={120} />
          </div>
        </>
      )}
      <p className="text-xs text-gray-500">Nothing is sent or submitted. Drafts wait for your approval before they are marked ready or saved.</p>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create task"}
      </Button>
    </form>
  );
}

/** Pause / resume / cancel / retry, shown only when the transition is allowed. */
export function TaskControls({ id, status, uncertain, canRetry }: { id: string; status: TaskStatus; uncertain: boolean; canRetry: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmUncertain, setConfirm] = useState(false);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const r = await api(`/api/tasks/${id}/control`, { body });
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    router.refresh();
  };
  const pausable = ["queued", "running", "waiting_for_browser", "waiting_for_approval"].includes(status);
  const cancellable = pausable || status === "paused" || status === "failed";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {pausable && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act({ action: "pause" })}>
            Pause
          </Button>
        )}
        {status === "paused" && !uncertain && (
          <Button size="sm" disabled={busy} onClick={() => void act({ action: "resume" })}>
            Resume
          </Button>
        )}
        {canRetry && (status === "failed" || uncertain) && (
          <Button size="sm" disabled={busy || (uncertain && !confirmUncertain)} onClick={() => void act({ action: "retry", confirmUncertain })}>
            Retry
          </Button>
        )}
        {cancellable && (
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void act({ action: "cancel" })}>
            Cancel task
          </Button>
        )}
      </div>
      {uncertain && (
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={confirmUncertain} onChange={(e) => setConfirm(e.target.checked)} className="mt-1" />
          I checked: the interrupted step did not happen, so it is safe to run it again.
        </label>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

export function ApprovalActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    const r = await api(`/api/approvals/${id}`, { body: { decision } });
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    router.refresh();
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide("approve")}>
          Approve
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void decide("reject")}>
          Reject
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

/** Re-reads the page every few seconds while the task can still change. */
export function AutoRefresh({ active, ms = 3000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
  return null;
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setDone(true),
          () => setDone(false),
        )
      }
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}
