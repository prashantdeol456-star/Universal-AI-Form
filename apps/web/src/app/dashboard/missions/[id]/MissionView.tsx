"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { getMission } from "@/server/companion/missions";
import { MISSION_LABEL, MISSION_TONE, PART_LABEL, PART_TONE } from "../meta";

type Mission = Awaited<ReturnType<typeof getMission>>;
const AGENT_TEXT: Record<string, string> = { file: "File agent", command: "Command agent" };
const PROVIDER_TEXT: Record<string, string> = { rules: "written by rules (no AI)", local: "written by the self-hosted model", gemini: "written by Gemini (all computers allow cloud AI)" };

export function MissionView({ initial }: { initial: Mission }) {
  const router = useRouter();
  const [m, setM] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const r = await api<Mission>(`/api/agent/missions/${initial.id}`);
    if (r.ok) setM(r.data);
  }, [initial.id]);
  useEffect(() => {
    if (!["running", "paused", "planned"].includes(m.status)) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [m.status, reload]);

  async function control(action: string, seq?: number) {
    setBusy(true);
    setError(null);
    const r = await api(`/api/agent/missions/${m.id}/control`, { body: { action, seq: seq ?? null } });
    setBusy(false);
    if (!r.ok) setError(r.error.message + ((r.error.details as { missing?: string[] } | undefined)?.missing ? `: ${(r.error.details as { missing: string[] }).missing.join("; ")}` : ""));
    void reload();
  }
  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(true);
    const r = await api(`/api/approvals/${id}`, { body: { decision } });
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    void reload();
  }
  async function del() {
    if (!confirm("Delete this mission? Its tasks stay under Tasks.")) return;
    const r = await api(`/api/agent/missions/${m.id}`, { method: "DELETE" });
    if (r.ok) router.push("/dashboard/missions");
    else setError(r.error.message);
  }
  const groups = [...new Set(m.parts.map((p) => p.grp))];

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm">
            <Badge tone={MISSION_TONE[m.status]}>{MISSION_LABEL[m.status]}</Badge>
            {m.statusReason && <p className="mt-1 text-amber-800">{m.statusReason}</p>}
            <p className="mt-1 text-xs text-gray-500">Your request: “{m.request}”</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {m.status === "planned" && (
              <Button size="sm" disabled={busy} onClick={() => void control("start")}>
                Start mission
              </Button>
            )}
            {m.status === "running" && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void control("pause")}>
                Pause
              </Button>
            )}
            {m.status === "paused" && (
              <Button size="sm" disabled={busy} onClick={() => void control("resume")}>
                Resume
              </Button>
            )}
            {["planned", "running", "paused"].includes(m.status) && (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void control("cancel")}>
                Cancel mission
              </Button>
            )}
            {["planned", "completed", "failed", "cancelled"].includes(m.status) && (
              <Button size="sm" variant="ghost" onClick={() => void del()}>
                Delete
              </Button>
            )}
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
      </Card>

      <Card title="Planner agent: steps">
        <ol className="space-y-3">
          {groups.map((g) => (
            <li key={g} className="rounded-lg border border-gray-100 p-3">
              <div className="mb-2 text-xs font-semibold text-gray-500">
                Step {g}
                {m.parts.filter((p) => p.grp === g).length > 1 ? " · in parallel" : ""}
              </div>
              <ul className="space-y-2">
                {m.parts
                  .filter((p) => p.grp === g)
                  .map((p) => (
                    <li key={p.seq} className="text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={p.agent === "command" ? "amber" : "blue"}>{AGENT_TEXT[p.agent]}</Badge>
                        <b>{p.deviceName}</b>
                        <span className={`h-2 w-2 rounded-full ${p.deviceOnline ? "bg-green-500" : "bg-gray-300"}`} title={p.deviceOnline ? "online" : "offline"} />
                        <Badge tone={PART_TONE[p.status]}>{PART_LABEL[p.status]}</Badge>
                        {p.taskId && (
                          <Link href={`/dashboard/tasks/${p.taskId}`} className="text-xs text-brand-700 hover:underline">
                            open task
                          </Link>
                        )}
                      </div>
                      <p className="mt-1 text-gray-700">{p.explanation}</p>
                      {p.status === "running" && !p.deviceOnline && p.taskStatus === "waiting_for_browser" && <p className="text-xs text-amber-700">Waiting for {p.deviceName}: start the companion there.</p>}
                      {p.taskStatus === "paused" && <p className="text-xs text-amber-700">The task is paused; open it to resume or check it.</p>}
                      {p.error && <p className="text-xs text-red-700">{p.error}</p>}
                      {p.approvals.map((a) => (
                        <div key={a.id} className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2">
                          <p>{a.summary}</p>
                          <div className="mt-1 flex gap-2">
                            <Button size="sm" disabled={busy} onClick={() => void decide(a.id, "approve")}>
                              Approve
                            </Button>
                            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(a.id, "reject")}>
                              Reject
                            </Button>
                          </div>
                        </div>
                      ))}
                      {m.status === "paused" && (p.status === "failed" || p.status === "cancelled") && (
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" disabled={busy} onClick={() => void control("retry", p.seq)}>
                            Retry this step
                          </Button>
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void control("skip", p.seq)}>
                            Skip it
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Reviewer agent">
        {m.review ? (
          <div className="space-y-2 text-sm">
            <p className="text-gray-900">{m.review.overview}</p>
            <ul className="list-disc pl-5 text-gray-700">
              {m.review.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="text-xs text-gray-500">Review {PROVIDER_TEXT[m.reviewProvider ?? "rules"]}; it saw only counts and results, never file contents.</p>
          </div>
        ) : (
          <p className="text-sm text-gray-500">The review is written when every step has finished.</p>
        )}
      </Card>
    </div>
  );
}
