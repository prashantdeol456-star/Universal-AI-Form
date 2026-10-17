"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { APPLICATION_STATUS_LABELS, APPLICATION_STATUSES, dueState, SUBMITTED_STATUSES, type ApplicationStatus } from "@ufa/jobs";
import { Alert, Badge, Button, Card, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { JobAnalysisView, JobDetail } from "@/server/jobs/types";
import type { KnowledgeAnswer } from "@/server/knowledge/types";
import { money, scoreTone } from "../JobsNav";
import { FeedbackCard } from "./FeedbackCard";

const EVIDENCE_TEXT = { verified: "confirmed", document: "in your document", unconfirmed: "not confirmed", missing: "not found" } as const;
const EVIDENCE_TONE = { verified: "green", document: "blue", unconfirmed: "amber", missing: "red" } as const;

function MatchCard({ job }: { job: JobDetail }) {
  const m = job.match;
  if (!m) return <Card title="Fit">No score yet. Use “Recalculate” on the Jobs page after updating your profile.</Card>;
  return (
    <Card title="How well your records fit">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={scoreTone(m.score)}>{m.score === null ? "Not enough information" : `${m.score}/100`}</Badge>
        {m.provisional && <Badge tone="amber">Provisional: the description lists few clear requirements</Badge>}
      </div>
      <p className="mt-1 text-xs text-gray-500">{m.note} Calculated by fixed rules (no AI); factors that do not apply are left out.</p>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500">
            <th className="py-1">Factor</th>
            <th>Weight</th>
            <th>Credit</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {m.factors.map((f) => (
            <tr key={f.key} className={`border-t border-gray-100 ${f.applicable ? "" : "text-gray-400"}`}>
              <td className="py-1.5">{f.label}</td>
              <td>{f.weight}</td>
              <td>{f.applicable ? `${Math.round(f.credit! * 100)}%` : "n/a"}</td>
              <td className="text-xs">{f.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {m.skills.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {m.skills.map((s) => (
            <li key={`${s.kind}-${s.skill}`} className="flex flex-wrap items-center gap-2">
              <Badge tone={EVIDENCE_TONE[s.evidence.status]}>{EVIDENCE_TEXT[s.evidence.status]}</Badge>
              <span>
                {s.skill}
                {s.kind === "preferred" ? <span className="text-gray-500"> (preferred)</span> : null}
              </span>
              {s.evidence.source &&
                (s.evidence.documentId ? (
                  <Link href={`/dashboard/documents/${s.evidence.documentId}`} className="text-xs text-brand-700 hover:underline">
                    {s.evidence.source}
                  </Link>
                ) : (
                  <span className="text-xs text-gray-500">{s.evidence.source}</span>
                ))}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-xs font-semibold text-gray-700">Highlight (found in your records)</div>
          <ul className="list-disc pl-4 text-gray-700">{m.strong.length ? m.strong.map((x) => <li key={x}>{x}</li>) : <li className="list-none text-gray-400">Nothing yet</li>}</ul>
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-700">Needs review</div>
          <ul className="list-disc pl-4 text-gray-700">{m.needsReview.length ? m.needsReview.map((x) => <li key={x}>{x}</li>) : <li className="list-none text-gray-400">Nothing</li>}</ul>
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-700">Missing evidence</div>
          <ul className="list-disc pl-4 text-gray-700">{m.missing.length ? m.missing.map((x) => <li key={x}>{x}</li>) : <li className="list-none text-gray-400">Nothing</li>}</ul>
        </div>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Missing something you have? Add it to <Link href="/dashboard/profile" className="text-brand-700 hover:underline">My Profile</Link> or upload your CV in{" "}
        <Link href="/dashboard/documents" className="text-brand-700 hover:underline">Documents</Link>. Never claim what you cannot show.
      </p>
    </Card>
  );
}

function AnalysisCard({ jobId, initial }: { jobId: string; initial: JobAnalysisView | null }) {
  const [a, setA] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    const res = await api<JobAnalysisView>(`/api/jobs/${jobId}/analyze`, { method: "POST" });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setError(null);
    setA(res.data);
  }
  return (
    <Card
      title="AI summary of the job"
      actions={
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run()}>
          {busy ? "Reading…" : a ? "Summarise again" : "Summarise with AI"}
        </Button>
      }
    >
      <p className="text-xs text-gray-500">Only the public job text is sent to the AI, never your profile or documents. Every point must quote the description; others are removed.</p>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      {a && (
        <div className="mt-2 space-y-2 text-sm">
          <p className="text-xs text-amber-700">AI-generated ({a.provider === "local" ? "self-hosted model" : "Google Gemini"}) — check against the description below.</p>
          <p className="text-gray-900">{a.summary}</p>
          {a.responsibilities.length > 0 && (
            <div>
              <div className="text-xs font-semibold">Responsibilities</div>
              <ul className="list-disc pl-4">{a.responsibilities.map((x, i) => <li key={i}>{x.text} <span className="text-xs text-gray-500">“{x.quote}”</span></li>)}</ul>
            </div>
          )}
          {a.requirements.length > 0 && (
            <div>
              <div className="text-xs font-semibold">Requirements</div>
              <ul className="list-disc pl-4">
                {a.requirements.map((x, i) => (
                  <li key={i}>
                    {x.kind === "preferred" ? <Badge tone="gray">preferred</Badge> : null} {x.text} <span className="text-xs text-gray-500">“{x.quote}”</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(a.interviewQuestions ?? []).length > 0 && (
            <div>
              <div className="text-xs font-semibold">Interview practice questions</div>
              <ul className="list-disc pl-4">
                {a.interviewQuestions.map((x, i) => (
                  <li key={i}>
                    {x.question} <span className="text-xs text-gray-500">(about: “{x.quote}”)</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-500">Prepare answers from what you have really done; use “Prepare an answer” on the right to find it in your documents.</p>
            </div>
          )}
          {a.dropped > 0 && <p className="text-xs text-gray-500">{a.dropped} point(s) without a matching quote were removed.</p>}
        </div>
      )}
    </Card>
  );
}

function TrackerCard({ job, today }: { job: JobDetail; today: string }) {
  const router = useRouter();
  const app = job.application;
  const [status, setStatus] = useState<ApplicationStatus>(app?.status ?? "interested");
  const [confirm, setConfirm] = useState(false);
  const [deadline, setDeadline] = useState(app?.deadline ?? "");
  const [follow, setFollow] = useState(app?.nextFollowUp ?? "");
  const [notes, setNotes] = useState(app?.notes ?? "");
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const needsConfirm = SUBMITTED_STATUSES.has(status) && !app?.submittedConfirmedAt;

  async function save() {
    const body: Record<string, unknown> = { deadline: deadline || null, nextFollowUp: follow || null, notes: notes.trim() || null };
    if (status !== (app?.status ?? null)) body.status = status;
    if (needsConfirm) body.confirmSubmitted = confirm;
    const res = await api(`/api/jobs/${job.id}/application`, { method: "PUT", body });
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message });
    setMsg({ tone: "green", text: "Saved." });
    router.refresh();
  }

  const due = (d: string | null, label: string) => {
    const s = dueState(d, today);
    return s === "overdue" ? <Badge tone="red">{label} overdue</Badge> : s === "today" ? <Badge tone="amber">{label} today</Badge> : s === "soon" ? <Badge tone="amber">{label} soon</Badge> : null;
  };

  return (
    <Card title="Your application">
      <div className="flex flex-wrap gap-2">
        {app ? <Badge tone="blue">{APPLICATION_STATUS_LABELS[app.status]}</Badge> : <Badge>Not tracked yet</Badge>}
        {app?.submittedConfirmedAt && <Badge tone="green">You confirmed submitting it on {new Date(app.submittedConfirmedAt).toLocaleDateString("en-IN")}</Badge>}
        {due(app?.deadline ?? null, "Deadline")}
        {due(app?.nextFollowUp ?? null, "Follow-up")}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <label className="text-sm">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ApplicationStatus)} className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {APPLICATION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Deadline
          <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <label className="text-sm">
          Next follow-up
          <Input type="date" value={follow} onChange={(e) => setFollow(e.target.value)} />
        </label>
      </div>
      {needsConfirm && (
        <label className="mt-2 flex items-start gap-2 text-sm text-amber-800">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />I submitted this application myself on the employer&apos;s website. (Filling a form with the assistant
          never counts as applying.)
        </label>
      )}
      <label className="mt-2 block text-sm">
        Notes (only for you)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} rows={3} className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" onClick={() => void save()}>
          Save
        </Button>
        {msg && <span className={`text-sm ${msg.tone === "red" ? "text-red-700" : "text-emerald-700"}`}>{msg.text}</span>}
      </div>
      {job.fills.length > 0 && (
        <div className="mt-3 text-sm">
          <div className="text-xs font-semibold text-gray-700">Forms you filled on this job&apos;s site with the assistant</div>
          <ul className="text-gray-700">
            {job.fills.map((f) => (
              <li key={f.id}>
                <Link href={`/dashboard/applications/${f.id}`} className="text-brand-700 hover:underline">
                  {new Date(f.createdAt).toLocaleString("en-IN")}
                </Link>{" "}
                — {f.submittedAt ? "you marked it submitted" : "filled, not marked submitted"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {job.events.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-xs text-gray-600">Activity ({job.events.length})</summary>
          <ul className="mt-1 text-xs text-gray-600">
            {job.events.map((e, i) => (
              <li key={i}>
                {new Date(e.at).toLocaleString("en-IN")} — {e.kind === "status" ? `status ${e.fromStatus} → ${e.toStatus}` : e.kind === "created" ? "started tracking" : `${e.kind.replace("_", " ")} changed`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function OpenJobCard({ job }: { job: JobDetail }) {
  const target = job.applyUrl ?? job.canonicalUrl;
  const host = new URL(target).host;
  const [reviewing, setReviewing] = useState(false);
  return (
    <Card title="Apply on the employer's site">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
        <li>Check the address, then open the page in a new tab.</li>
        <li>In the extension, allow this site under “Site access” (read and fill) and press Analyze.</li>
        <li>Review every proposed value and its source, then fill. Upload your CV only if you choose to.</li>
        <li>Log in, CAPTCHA, OTP and Submit are always yours. Then set the status here.</li>
      </ol>
      {!reviewing ? (
        <Button className="mt-3" size="sm" onClick={() => setReviewing(true)}>
          Open the job page…
        </Button>
      ) : (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <div>
            You are about to open <b>{host}</b>:
          </div>
          <div className="break-all text-xs text-gray-700">{target}</div>
          <div className="mt-2 flex gap-2">
            <a href={target} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700" onClick={() => setReviewing(false)}>
              Open {host}
            </a>
            <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function DraftAnswerCard({ jobId }: { jobId: string }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<KnowledgeAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    if (q.trim().length < 3) return setError("Type the application question.");
    setBusy(true);
    const res = await api<KnowledgeAnswer>(`/api/jobs/${jobId}/answer`, { body: { question: q.trim() } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setError(null);
    setA(res.data);
  }
  return (
    <Card title="Prepare an answer to an application question">
      <div className="flex gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="e.g. Describe your project management experience" />
        <Button size="sm" disabled={busy} onClick={() => void run()}>
          {busy ? "Writing…" : "Draft"}
        </Button>
      </div>
      {error && <div className="mt-2"><Alert>{error}</Alert></div>}
      {a && (
        <div className="mt-2 space-y-2 text-sm">
          {a.status === "answered" ? (
            <>
              <p className="whitespace-pre-wrap">{a.summary}</p>
              <p className="text-xs text-amber-700">AI-generated from your documents; each statement below quotes its source. Check before you paste it anywhere.</p>
              <ul className="list-disc pl-4 text-xs text-gray-600">
                {a.statements.map((s, i) => <li key={i}>{s.text} [{s.refs.join(", ")}: “{s.quote}”]</li>)}
              </ul>
            </>
          ) : a.status === "not_found" ? (
            <Alert tone="blue">Your documents and profile do not cover this. Write it yourself or add the facts to your profile first — nothing was invented.</Alert>
          ) : a.status === "conflict" ? (
            <Alert tone="amber">Your sources disagree on this. Resolve it in Documents first.</Alert>
          ) : (
            <Alert tone="amber">No AI draft (cloud AI not allowed for these documents, or the AI failed). Exact excerpts from your documents:</Alert>
          )}
          {a.excerpts.length > 0 && (
            <ul className="space-y-1 text-xs text-gray-700">
              {a.excerpts.map((e) => (
                <li key={e.ref}>
                  <b>{e.ref}</b> {e.documentTitle}
                  {e.page ? `, page ${e.page}` : ""}: {e.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

export function JobDetailView({ job, today }: { job: JobDetail; today: string }) {
  const router = useRouter();
  const [notes, setNotes] = useState(job.notes ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  async function save(body: Record<string, unknown>) {
    const res = await api(`/api/jobs/${job.id}/save`, { method: "PUT", body: { saved: true, ...body } });
    setMsg(res.ok ? "Saved." : res.error.message);
    router.refresh();
  }
  async function remove() {
    if (!window.confirm("Remove this job from your list? A tracked application keeps its title and link.")) return;
    const res = await api(`/api/jobs/${job.id}`, { method: "DELETE" });
    if (res.ok) router.push("/dashboard/jobs");
  }
  return (
    <>
      <div>
        <Link href="/dashboard/jobs" className="text-sm text-brand-600 hover:underline">
          ← Jobs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{job.title}</h1>
        <p className="text-sm text-gray-600">
          {job.employer ?? "Employer not given"} · {job.location ?? "Location not given"} · {job.workArrangement ?? "arrangement not given"} · {job.employmentType ?? "type not given"}
        </p>
        <p className="text-xs text-gray-500">
          Source: {job.sourceLabel} · found {new Date(job.retrievedAt).toLocaleDateString("en-IN")} · last seen at source {new Date(job.lastSeenAt).toLocaleDateString("en-IN")}
          {job.publishedAt ? ` · published ${new Date(job.publishedAt).toLocaleDateString("en-IN")}` : " · publication date not given"}
          {job.salary ? ` · pay ${money(job.salary.min, job.salary.currency)}–${money(job.salary.max, job.salary.currency)} (from ${job.salary.source})` : " · pay not given by the source"}
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {job.status === "closed" && <Badge tone="red">No longer listed at the source</Badge>}
          {job.stale && job.status !== "closed" && <Badge tone="amber">Not re-checked for over 14 days — it may have closed</Badge>}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-6">
          <MatchCard job={job} />
          <FeedbackCard job={job} />
          <AnalysisCard jobId={job.id} initial={job.analysis} />
          <Card title="Job description (from the source)">
            {job.experienceText && <p className="mb-2 text-xs text-gray-600">Experience requirement read: “{job.experienceText}”</p>}
            <p className="whitespace-pre-wrap text-sm text-gray-800">{job.description || "The source gave no description."}</p>
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Shortlist">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Button size="sm" variant={job.saved ? "secondary" : "primary"} onClick={() => void (job.saved ? api(`/api/jobs/${job.id}/save`, { method: "PUT", body: { saved: false } }).then(() => router.refresh()) : save({}))}>
                {job.saved ? "Unsave" : "Save"}
              </Button>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={job.shortlisted} onChange={(e) => void save({ shortlisted: e.target.checked })} /> Shortlisted
              </label>
              <select value={job.priority ?? 2} onChange={(e) => void save({ priority: Number(e.target.value) })} className="rounded-lg border border-gray-300 px-2 py-1 text-sm" aria-label="Priority">
                <option value={1}>High priority</option>
                <option value={2}>Normal priority</option>
                <option value={3}>Low priority</option>
              </select>
            </div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (job.notes ?? "") && void save({ notes: notes.trim() || null })} maxLength={4000} rows={2} placeholder="Notes about this job" className="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
            {msg && <p className="text-xs text-gray-500">{msg}</p>}
            <button className="mt-2 text-xs text-red-700 hover:underline" onClick={() => void remove()}>
              Remove this job
            </button>
          </Card>
          <TrackerCard job={job} today={today} />
          <OpenJobCard job={job} />
          <DraftAnswerCard jobId={job.id} />
        </div>
      </div>
    </>
  );
}
