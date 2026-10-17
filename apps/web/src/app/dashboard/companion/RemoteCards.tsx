"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Label } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { DeviceView } from "@/server/companion/service";

/** Online / offline / stopped at a glance, for every paired computer. */
export function DevicesOverview({ devices }: { devices: DeviceView[] }) {
  const active = devices.filter((d) => d.status === "active");
  if (!active.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Your computers">
      {active.map((d) => (
        <span key={d.id} className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm">
          <span className={`h-2 w-2 rounded-full ${d.stopped ? "bg-red-500" : d.online ? "bg-green-500" : "bg-gray-300"}`} aria-hidden />
          {d.name}
          <span className="text-xs text-gray-500">{d.stopped ? "stopped" : d.online ? "online" : "offline"}</span>
        </span>
      ))}
      <span className="self-center text-xs text-gray-500">
        {active.filter((d) => d.online).length} of {active.length} online
      </span>
    </div>
  );
}

interface PendingApproval {
  id: string;
  taskId: string;
  title: string;
  summary: string;
  expiresAt: string;
}

/** Approvals waiting on computer tasks, approvable from a phone. Each one allows exactly one action. */
export function ApprovalsCard() {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ approvals: PendingApproval[] }>("/api/agent/approvals");
    if (r.ok) setItems(r.data.approvals);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);
  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(id);
    setError(null);
    const r = await api(`/api/approvals/${id}`, { body: { decision } });
    setBusy(null);
    if (!r.ok) setError(r.error.message);
    void load();
  }
  if (!items.length && !error) return null;
  return (
    <Card title={<span>Waiting for your approval <Badge tone="amber">{items.length}</Badge></span>}>
      <ul className="space-y-3">
        {items.map((a) => (
          <li key={a.id} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
            <Link href={`/dashboard/tasks/${a.taskId}`} className="font-medium text-gray-900 hover:underline">
              {a.title}
            </Link>
            <p className="mt-1 text-gray-700">{a.summary}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy === a.id} onClick={() => void decide(a.id, "approve")}>
                Approve
              </Button>
              <Button size="sm" variant="secondary" disabled={busy === a.id} onClick={() => void decide(a.id, "reject")}>
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}

const AGENT_TEXT: Record<string, string> = { file: "File agent", command: "Command agent" };
const MISSION_EXAMPLES = ["Summarise the files in Invoices, then create a report of the invoices", "Run git status on all computers", "On Office PC run the tests in my-app, then organise Downloads"];

interface MissionPart {
  seq: number;
  grp: number;
  agent: string;
  deviceName: string;
  taskType: string;
  explanation: string;
  steps: string[];
  missing: string[];
}
type MissionPlan = { ok: true; missionId: string; notes: string[]; parts: MissionPart[] } | { ok: false; question: string };

/** Multi-agent mission: the Planner agent splits the request; File / Command agents work on your computers. */
export function MissionCard({ devices }: { devices: DeviceView[] }) {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [plan, setPlan] = useState<MissionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deviceId = devices[0]?.id ?? null;

  async function makePlan() {
    setBusy(true);
    setError(null);
    const r = await api<MissionPlan>("/api/agent/missions", { body: { request, deviceId } });
    setBusy(false);
    if (r.ok) setPlan(r.data);
    else setError(r.error.message);
  }
  async function start(id: string) {
    setBusy(true);
    const r = await api(`/api/agent/missions/${id}/control`, { body: { action: "start" } });
    setBusy(false);
    if (r.ok) router.push(`/dashboard/missions/${id}`);
    else setError(r.error.message + ((r.error.details as { missing?: string[] } | undefined)?.missing ? `: ${(r.error.details as { missing: string[] }).missing.join("; ")}` : ""));
  }
  const missing = plan?.ok ? plan.parts.flatMap((p) => p.missing.map((m) => `Step ${p.seq} on ${p.deviceName}: ${m}`)) : [];
  const groups = plan?.ok ? [...new Set(plan.parts.map((p) => p.grp))] : [];

  return (
    <Card title="Multi-agent mission">
      <p className="mb-2 text-xs text-gray-500">
        Several steps, several computers. The Planner agent splits your request (use “then” between steps, “on &lt;computer&gt;” or “on all computers”); File and Command agents do each step as a normal task with its own approvals; the Reviewer agent sums up. Steps run in order; a failed step pauses the mission.
      </p>
      <Label htmlFor="mission-text">What should your computers do?</Label>
      <textarea id="mission-text" value={request} onChange={(e) => setRequest(e.target.value)} maxLength={1000} rows={3} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder={MISSION_EXAMPLES[0]} />
      <div className="mt-1 flex flex-wrap gap-1">
        {MISSION_EXAMPLES.map((x) => (
          <button key={x} type="button" className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50" onClick={() => setRequest(x)}>
            {x}
          </button>
        ))}
      </div>
      <div className="mt-2">
        <Button onClick={() => void makePlan()} disabled={busy || request.trim().length < 3}>
          Plan the mission
        </Button>
      </div>
      {plan && !plan.ok && <Alert tone="amber">{plan.question}</Alert>}
      {plan?.ok && (
        <div className="mt-3 space-y-3 text-sm">
          {groups.map((g) => (
            <div key={g} className="rounded-lg border border-gray-200 p-3">
              <div className="mb-1 text-xs font-semibold text-gray-500">
                Step {g}
                {plan.parts.filter((p) => p.grp === g).length > 1 ? " · runs on these computers in parallel" : ""}
              </div>
              {plan.parts
                .filter((p) => p.grp === g)
                .map((p) => (
                  <div key={p.seq} className="mt-1">
                    <Badge tone={p.agent === "command" ? "amber" : "blue"}>{AGENT_TEXT[p.agent]}</Badge> <b>{p.deviceName}</b>: {p.explanation}
                  </div>
                ))}
            </div>
          ))}
          <p className="text-xs text-gray-500">Then the Reviewer agent writes one review of all results.</p>
          {plan.notes.map((n) => (
            <p key={n} className="text-xs text-amber-700">
              {n}
            </p>
          ))}
          {missing.length > 0 ? (
            <Alert tone="amber">
              Missing before this can run:
              <ul className="list-disc pl-5">
                {missing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Alert>
          ) : (
            <Button onClick={() => void start(plan.missionId)} disabled={busy}>
              Start mission
            </Button>
          )}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <p className="mt-3 text-xs">
        <Link href="/dashboard/missions" className="text-brand-700 hover:underline">
          All missions
        </Link>
      </p>
    </Card>
  );
}
