"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Input } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { FeedbackView } from "@/server/jobs/feedback";
import type { JobDetail } from "@/server/jobs/types";

const TARGET_TEXT: Record<string, string> = {
  required_skill: "required skill",
  preferred_skill: "preferred skill",
  experience_min_years: "minimum experience",
  education_level: "education level",
};

/**
 * Feedback on this job's match: a usefulness vote (stored for your review; it changes
 * nothing on its own), corrections of what was read from the description (they change this
 * job's score), and an optional ranking rule you approve (it changes the order only).
 */
export function FeedbackCard({ job }: { job: JobDetail }) {
  const router = useRouter();
  const [items, setItems] = useState<FeedbackView[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [reason, setReason] = useState("");
  const [skill, setSkill] = useState("");
  const [skillKind, setSkillKind] = useState<"required_skill" | "preferred_skill">("required_skill");
  const [years, setYears] = useState("");
  const [lastVote, setLastVote] = useState<FeedbackView | null>(null);

  const load = async () => {
    const res = await api<{ feedback: FeedbackView[] }>(`/api/jobs/${job.id}/feedback`);
    if (res.ok) setItems(res.data.feedback);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per job
  }, [job.id]);

  async function send(body: Record<string, unknown>, done: string) {
    const res = await api<FeedbackView>(`/api/jobs/${job.id}/feedback`, { body });
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message }), null;
    setMsg({ tone: "green", text: done });
    await load();
    router.refresh();
    return res.data;
  }

  async function vote(useful: boolean) {
    const f = await send({ kind: "match_useful", useful, reason: reason.trim() || null }, "Thanks — saved for your review. It does not change any score by itself.");
    if (f) setLastVote(f);
    setReason("");
  }

  async function rule(kind: "employer" | "title_word", value: string, weight: number) {
    const res = await api(`/api/jobs/rules`, { body: { kind, value, weight, reason: lastVote?.reason ?? null, sourceFeedbackId: lastVote?.id ?? null } });
    setMsg(res.ok ? { tone: "green", text: "Ranking rule added. It re-orders jobs; fit scores stay the same." } : { tone: "red", text: res.error.message });
    router.refresh();
  }

  async function remove(id: string) {
    const res = await api(`/api/jobs/feedback/${id}`, { method: "DELETE" });
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message });
    await load();
    router.refresh();
  }

  const skills = job.match?.skills ?? [];
  return (
    <Card title="Your feedback on this match">
      {msg && <div className="mb-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}

      <div className="text-sm">
        <div className="font-medium text-gray-800">Was this match useful?</div>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why? (optional, e.g. wrong seniority)" className="mt-1" />
        <div className="mt-1 flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => void vote(true)}>
            👍 Useful
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void vote(false)}>
            👎 Not useful
          </Button>
        </div>
        {lastVote && (
          <div className="mt-2 rounded-lg border border-gray-200 p-2 text-xs text-gray-700">
            Turn this into a ranking rule? (optional — you can delete it any time)
            <div className="mt-1 flex flex-wrap gap-1">
              {job.employer && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void rule("employer", job.employer!, 5)}>
                    Prefer {job.employer}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void rule("employer", job.employer!, -5)}>
                    Rank {job.employer} lower
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 text-sm">
        <div className="font-medium text-gray-800">Correct what was read from the description</div>
        <p className="text-xs text-gray-500">Corrections change this job&apos;s score only. They never change your profile.</p>
        {skills.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-1">
            {skills.map((s) => (
              <li key={`${s.kind}-${s.skill}`}>
                <button
                  className="rounded-full border border-gray-200 px-2 py-0.5 text-xs hover:border-red-300 hover:text-red-700"
                  title="Not really asked for in this job: remove"
                  onClick={() => void send({ kind: "requirement_correction", target: s.kind === "required" ? "required_skill" : "preferred_skill", action: "remove", value: s.skill }, `Removed “${s.skill}” from this job's requirements.`)}
                >
                  {s.skill} {s.kind === "preferred" ? "(preferred)" : ""} ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          <Input value={skill} onChange={(e) => setSkill(e.target.value)} maxLength={100} placeholder="Missed skill" className="w-40" />
          <select value={skillKind} onChange={(e) => setSkillKind(e.target.value as typeof skillKind)} className="rounded-lg border border-gray-300 px-2 text-sm" aria-label="Required or preferred">
            <option value="required_skill">required</option>
            <option value="preferred_skill">preferred</option>
          </select>
          <Button size="sm" variant="secondary" disabled={!skill.trim()} onClick={() => void send({ kind: "requirement_correction", target: skillKind, action: "add", value: skill.trim() }, `Added “${skill.trim()}”.`).then(() => setSkill(""))}>
            Add
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <Input value={years} onChange={(e) => setYears(e.target.value)} placeholder="Years asked (or none)" className="w-44" />
          <Button size="sm" variant="secondary" disabled={!years.trim()} onClick={() => void send({ kind: "requirement_correction", target: "experience_min_years", action: "set", value: years.trim() }, "Experience requirement set.").then(() => setYears(""))}>
            Set experience
          </Button>
          <select defaultValue="" onChange={(e) => e.target.value && void send({ kind: "requirement_correction", target: "education_level", action: "set", value: e.target.value }, "Education requirement set.")} className="rounded-lg border border-gray-300 px-2 text-sm" aria-label="Set education level">
            <option value="">Set education…</option>
            <option value="none">No education requirement</option>
            <option value="diploma">Diploma</option>
            <option value="bachelor">Bachelor</option>
            <option value="master">Master</option>
            <option value="phd">PhD</option>
          </select>
        </div>
      </div>

      {job.rankExplanation.length > 0 && (
        <div className="mt-4 text-xs text-gray-600">
          Your ranking rules move this job {job.rankAdjustment > 0 ? "up" : "down"} by {Math.abs(job.rankAdjustment)}:{" "}
          {job.rankExplanation.map((r) => `${r.kind.replace("_", " ")} “${r.value}” ${r.weight > 0 ? "+" : ""}${r.weight}`).join(", ")}. The fit score is unchanged.
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs text-gray-700">
          {items.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2">
              <Badge tone="gray">{new Date(f.createdAt).toLocaleDateString("en-IN")}</Badge>
              {f.kind === "match_useful" ? (f.useful ? "Marked useful" : "Marked not useful") : `${f.action} ${TARGET_TEXT[f.target!]}: ${f.value}`}
              {f.reason ? <span className="text-gray-500">— {f.reason}</span> : null}
              <button className="text-red-700 hover:underline" onClick={() => void remove(f.id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-gray-500">
        Review everything in <Link href="/dashboard/jobs/feedback" className="text-brand-700 hover:underline">Your feedback &amp; rules</Link>.
      </p>
    </Card>
  );
}
