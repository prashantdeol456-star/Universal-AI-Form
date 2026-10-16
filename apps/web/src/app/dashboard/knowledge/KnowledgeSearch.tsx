"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, EmptyState, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { KnowledgeAnswer, KnowledgeConflict, KnowledgeExcerpt, KnowledgeFact, RetrievalResult } from "@/server/knowledge/types";

const EXAMPLES = ["What is my highest qualification?", "Dates of my previous employment", "Skills listed in my CV", "My project management experience"];

const REASON_TEXT: Record<string, string> = {
  no_evidence: "Nothing about this was found in your documents or profile.",
  sources_disagree: "Your sources disagree. Choose the right value first; no answer is written from conflicting facts.",
  cloud_not_allowed_for_these_documents: "Cloud AI is not allowed for the documents that matched, so no AI summary was written. The excerpts below are exact quotes. You can allow cloud AI per document on its page.",
  cloud_not_allowed_for_profile: "Cloud AI is not allowed to read your profile, so no AI summary was written.",
  no_consent: "Cloud AI is switched off in your settings, so no AI summary was written.",
  local_only: "This server uses local AI only and no local model is configured, so no AI summary was written.",
  not_configured: "No AI model is configured on this server, so no AI summary was written.",
  over_budget: "Today's AI limit is used up. The excerpts below are exact quotes.",
  provider_error: "The AI model did not answer. The excerpts below are exact quotes.",
  invalid_model_output: "The AI reply could not be checked against your documents, so it was discarded. The excerpts below are exact quotes.",
  model_found_no_support: "The AI found no statement it could back with a quote from your documents.",
};

function where(e: KnowledgeExcerpt) {
  return [e.page ? `page ${e.page}` : null, e.section].filter(Boolean).join(" · ");
}

function Excerpts({ excerpts }: { excerpts: KnowledgeExcerpt[] }) {
  if (!excerpts.length) return null;
  return (
    <Card title="From your documents">
      <ul className="space-y-3">
        {excerpts.map((e) => (
          <li key={e.ref} className="rounded-lg border border-gray-200 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <Badge tone="gray">{e.ref}</Badge>
              <Link href={`/dashboard/documents/${e.documentId}`} className="font-medium text-brand-700 hover:underline">
                {e.documentTitle}
              </Link>
              {where(e) && <span>{where(e)}</span>}
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-gray-800">{e.text}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-500">Excerpts are quoted exactly from your files. Text inside documents is never treated as instructions.</p>
    </Card>
  );
}

function Facts({ facts }: { facts: KnowledgeFact[] }) {
  if (!facts.length) return null;
  return (
    <Card title="In your profile">
      <ul className="divide-y divide-gray-100 text-sm">
        {facts.map((f, i) => (
          <li key={`${f.key}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-gray-600">{f.label}</span>
            <span className="flex flex-wrap items-center gap-2">
              <b className="text-gray-900">{f.value}</b>
              {f.verified ? <Badge tone="green">Confirmed by you</Badge> : f.source === "profile" ? <Badge tone="amber">Not confirmed</Badge> : <Badge tone="amber">Found in a document, not confirmed</Badge>}
              {f.sourceDocument && (
                <Link href={`/dashboard/documents/${f.sourceDocument.id}`} className="text-xs text-brand-700 hover:underline">
                  {f.sourceDocument.title}
                </Link>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Conflicts({ conflicts }: { conflicts: KnowledgeConflict[] }) {
  if (!conflicts.length) return null;
  return (
    <Alert tone="amber">
      <b>Your sources disagree.</b> Which one is correct?
      <ul className="mt-1 list-disc pl-5">
        {conflicts.map((c) => (
          <li key={c.key}>
            {c.label}: {c.values.map((v) => `${v.value} (${v.documentTitle ?? v.source}${v.verified ? ", confirmed" : ""})`).join(" vs ")}
          </li>
        ))}
      </ul>
      <Link href="/dashboard/documents" className="underline">
        Decide in Documents
      </Link>{" "}
      or correct it in{" "}
      <Link href="/dashboard/profile" className="underline">
        My Profile
      </Link>
      .
    </Alert>
  );
}

export function KnowledgeSearch({ hasDocuments }: { hasDocuments: boolean }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<null | "search" | "fact" | "draft">(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<RetrievalResult | null>(null);
  const [answer, setAnswer] = useState<KnowledgeAnswer | null>(null);

  async function run(kind: "search" | "fact" | "draft", e?: FormEvent) {
    e?.preventDefault();
    const query = q.trim();
    if (query.length < 2) return setError("Type a question or some words to look for.");
    setBusy(kind);
    setError(null);
    if (kind === "search") {
      const res = await api<RetrievalResult>(`/api/knowledge/search?q=${encodeURIComponent(query)}&limit=8`);
      setBusy(null);
      if (!res.ok) return setError(res.error.message);
      setAnswer(null);
      setSearch(res.data);
    } else {
      const res = await api<KnowledgeAnswer>("/api/knowledge/answer", { body: { question: query, mode: kind } });
      setBusy(null);
      if (!res.ok) return setError(res.error.message);
      setSearch(null);
      setAnswer(res.data);
    }
  }

  const shown = answer ?? search;
  return (
    <div className="space-y-4">
      <Card>
        <form onSubmit={(e) => void run("search", e)} className="flex flex-wrap gap-2">
          <label htmlFor="kq" className="sr-only">
            Question or words
          </label>
          <Input id="kq" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="e.g. What is my highest qualification?" className="min-w-[16rem] flex-1" />
          <Button type="submit" disabled={busy !== null}>
            {busy === "search" ? "Searching…" : "Search"}
          </Button>
          <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void run("fact")}>
            {busy === "fact" ? "Answering…" : "Answer with sources"}
          </Button>
          <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => void run("draft")}>
            {busy === "draft" ? "Writing…" : "Draft a form answer"}
          </Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="rounded-full border border-gray-200 px-2.5 py-0.5 text-xs text-gray-600 hover:bg-gray-50" onClick={() => setQ(x)}>
              {x}
            </button>
          ))}
        </div>
        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
      </Card>

      {!hasDocuments && !shown && (
        <EmptyState title="No searchable documents yet">
          Upload your CV (PDF, Word or text) in <Link href="/dashboard/documents" className="text-brand-700 hover:underline">Documents</Link>; it becomes searchable once it has been read.
        </EmptyState>
      )}

      {answer && (
        <>
          {answer.status === "answered" && (
            <Card title="Answer">
              <p className="whitespace-pre-wrap text-sm text-gray-900">{answer.summary}</p>
              <p className="mt-1 text-xs text-amber-700">
                Written by {answer.engine.provider === "local" ? "the self-hosted AI" : "Google Gemini"} from the excerpts below — check it before you use it. It does not make any fact
                “confirmed”.
              </p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {answer.statements.map((s, i) => (
                  <li key={i} className="text-gray-800">
                    {s.text} <span className="text-xs text-gray-500">[{s.refs.join(", ")}: “{s.quote}”]</span>
                  </li>
                ))}
              </ul>
              {answer.engine.dropped > 0 && <p className="mt-2 text-xs text-gray-500">{answer.engine.dropped} statement(s) without a matching quote were removed.</p>}
            </Card>
          )}
          {answer.status !== "answered" && answer.engine.reason && <Alert tone={answer.status === "not_found" ? "blue" : "amber"}>{REASON_TEXT[answer.engine.reason] ?? "No AI summary was written."}</Alert>}
        </>
      )}
      {search && search.status === "not_found" && <Alert tone="blue">Nothing about this was found in your documents or profile.</Alert>}

      {shown && <Conflicts conflicts={shown.conflicts} />}
      {shown && <Facts facts={shown.facts} />}
      {shown && <Excerpts excerpts={shown.excerpts} />}
    </div>
  );
}
