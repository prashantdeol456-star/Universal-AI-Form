"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { FeedbackView, RuleView } from "@/server/jobs/feedback";

const KIND_TEXT: Record<RuleView["kind"], string> = { employer: "Employer is", keyword: "Job text mentions", skill: "Job asks for skill", title_word: "Title contains" };

export function FeedbackManager({ initial }: { initial: { feedback: FeedbackView[]; rules: RuleView[] } }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);

  async function del(path: string) {
    const res = await api(path, { method: "DELETE" });
    setMsg(res.ok ? { tone: "green", text: "Deleted. Scores and order were recalculated." } : { tone: "red", text: res.error.message });
    router.refresh();
  }

  async function addRule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await api("/api/jobs/rules", {
      body: { kind: f.get("kind"), value: String(f.get("value") ?? "").trim(), weight: Number(f.get("weight")), reason: String(f.get("reason") ?? "").trim() || null },
    });
    setMsg(res.ok ? { tone: "green", text: "Rule added. Jobs were re-ordered; fit scores stay the same." } : { tone: "red", text: res.error.message });
    if (res.ok) e.currentTarget.reset();
    router.refresh();
  }

  const votes = initial.feedback.filter((f) => f.kind === "match_useful");
  const corrections = initial.feedback.filter((f) => f.kind === "requirement_correction");
  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card title={`Ranking rules (${initial.rules.length})`}>
        {initial.rules.length === 0 ? (
          <p className="text-sm text-gray-500">No rules. Add one below, or from a job&apos;s “Was this match useful?” vote.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {initial.rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {KIND_TEXT[r.kind]} “{r.value}” → <Badge tone={r.weight > 0 ? "green" : "amber"}>{r.weight > 0 ? `+${r.weight}` : r.weight}</Badge>
                  {r.reason ? <span className="text-xs text-gray-500"> — {r.reason}</span> : null}
                  {r.sourceFeedbackId ? <span className="text-xs text-gray-400"> (from a vote)</span> : null}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void del(`/api/jobs/rules/${r.id}`)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(e) => void addRule(e)} className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_8rem_1fr_auto] sm:items-end">
          <div>
            <Label htmlFor="kind">When</Label>
            <Select id="kind" name="kind" defaultValue="keyword">
              <option value="employer">Employer is</option>
              <option value="keyword">Job text mentions</option>
              <option value="skill">Job asks for skill</option>
              <option value="title_word">Title contains</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="value">Value</Label>
            <Input id="value" name="value" required maxLength={100} placeholder="e.g. night shift" />
          </div>
          <div>
            <Label htmlFor="weight">Move by</Label>
            <Select id="weight" name="weight" defaultValue="-5">
              {[10, 5, 3, -3, -5, -10].map((w) => (
                <option key={w} value={w}>
                  {w > 0 ? `+${w} (up)` : `${w} (down)`}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="reason" hint="(optional)">Why</Label>
            <Input id="reason" name="reason" maxLength={500} />
          </div>
          <Button type="submit">Add rule</Button>
        </form>
        <p className="mt-2 text-xs text-gray-500">Rules add at most ±20 to the order of a job; the fit score shown on each job never changes because of them.</p>
      </Card>

      <Card title={`Requirement corrections (${corrections.length})`}>
        {corrections.length === 0 ? (
          <p className="text-sm text-gray-500">None.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {corrections.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {f.jobId ? <Link href={`/dashboard/jobs/${f.jobId}`} className="text-brand-700 hover:underline">{f.jobTitle}</Link> : "Removed job"}: {f.action} {f.target?.replace(/_/g, " ")} “{f.value}”
                  {f.reason ? <span className="text-xs text-gray-500"> — {f.reason}</span> : null}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void del(`/api/jobs/feedback/${f.id}`)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Match votes (${votes.length})`}>
        {votes.length === 0 ? (
          <p className="text-sm text-gray-500">None.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {votes.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Badge tone={f.useful ? "green" : "amber"}>{f.useful ? "Useful" : "Not useful"}</Badge>{" "}
                  {f.jobId ? <Link href={`/dashboard/jobs/${f.jobId}`} className="text-brand-700 hover:underline">{f.jobTitle}</Link> : "Removed job"}
                  {f.reason ? <span className="text-xs text-gray-500"> — {f.reason}</span> : null}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void del(`/api/jobs/feedback/${f.id}`)}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-gray-500">Votes do not change scores or order by themselves.</p>
      </Card>
    </>
  );
}
