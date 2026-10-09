"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button } from "@/components/ui";
import { api } from "@/lib/api-client";

export function AnswerRow({ id, question, answer, meta }: { id: string; question: string; answer: string; meta: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(answer);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">{question}</div>
          {!editing && <p className="mt-1 text-sm whitespace-pre-wrap text-gray-700">{answer}</p>}
          <div className="mt-1 text-xs text-gray-400">{meta}</div>
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!confirm("Delete this saved answer?")) return;
                await api(`/api/answers/${id}`, { method: "DELETE" });
                router.refresh();
              }}
            >
              Delete
            </Button>
          </div>
        )}
      </div>
      {editing && (
        <form
          className="mt-2 space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await api(`/api/answers/${id}`, { method: "PATCH", body: { answer: value } });
            if (!r.ok) return setError(r.error.message);
            setEditing(false);
            router.refresh();
          }}
        >
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            maxLength={5000}
            aria-label={`Answer for ${question}`}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
          />
          {error && <Alert>{error}</Alert>}
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function AiSharingToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-2xl text-sm text-gray-600">
        {enabled ? "On" : "Off"}: for open questions (“Why do you want this job?”) the assistant may send your professional profile — summary, key
        skills, current job and education, never ID numbers, contact or family details — to Google Gemini to write a better answer. When off, answers
        are put together from your own profile text.
      </p>
      <Button
        variant={enabled ? "secondary" : "primary"}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api("/api/account/ai-sharing", { body: { enabled: !enabled } });
          setBusy(false);
          router.refresh();
        }}
      >
        {enabled ? "Turn off" : "Allow"}
      </Button>
    </div>
  );
}
