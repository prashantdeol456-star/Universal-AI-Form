"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import { timeAgo } from "@/lib/labels";
import type { DeviceView } from "@/server/companion/service";
import { ApprovalsCard, DevicesOverview, MissionCard } from "./RemoteCards";

interface CapabilityInfo {
  id: string;
  label: string;
  implemented: boolean;
  sideEffects: boolean;
}
interface Plan {
  taskType: string;
  input: Record<string, unknown>;
  explanation: string;
  steps: string[];
  missing: string[];
}
type PlanReply = ({ ok: true; plan: Plan } | { ok: false; question: string }) & { engine: { provider: string; reason: string | null } };

const PLATFORM: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export function CompanionClient({ devices, capabilities, ai }: { devices: DeviceView[]; capabilities: CapabilityInfo[]; commands: Array<{ id: string; label: string; effects: string }>; ai: { local: boolean; cloud: boolean } }) {
  const router = useRouter();
  const active = devices.filter((d) => d.status === "active");
  const [msg, setMsg] = useState<{ tone: "red" | "green" | "amber"; text: string } | null>(null);

  // Online state changes without user action: refresh every 15 s.
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [router]);

  async function stopAll() {
    const r = await api<{ devices: number; pausedTasks: number }>("/api/companion/stop", { body: {} });
    setMsg(r.ok ? { tone: "amber", text: `Emergency stop is on for ${r.data.devices} computer(s); ${r.data.pausedTasks} task(s) paused. Nothing resumes on its own.` } : { tone: "red", text: r.error.message });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
        <div className="text-sm text-red-900">
          <div className="font-semibold">Emergency stop</div>
          Stops every paired computer at once: the current action is interrupted, no new action starts, and tasks are paused.
        </div>
        <Button variant="danger" onClick={() => void stopAll()} disabled={!active.length}>
          Stop all computers
        </Button>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <DevicesOverview devices={devices} />
      <ApprovalsCard />

      <SetupCard hasDevice={active.length > 0} ai={ai} />
      <PairCard onPaired={() => router.refresh()} />
      {devices.map((d) => (
        <DeviceCard key={d.id} device={d} capabilities={capabilities} onChange={() => router.refresh()} />
      ))}
      {active.length > 0 && <AskCard devices={active} />}
      {active.length > 0 && <MissionCard devices={active} />}
    </div>
  );
}

function SetupCard({ hasDevice, ai }: { hasDevice: boolean; ai: { local: boolean; cloud: boolean } }) {
  const [origin, setOrigin] = useState("https://your-server");
  useEffect(() => setOrigin(window.location.origin), []);
  return (
    <Card title="Set up">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
        <li>
          On your computer, in the project folder: <code className="rounded bg-gray-100 px-1">npm run build:companion</code> (see <span className="font-mono text-xs">docs/companion.md</span>). Use a normal user account, not Administrator.
        </li>
        <li>
          Pair it: <code className="rounded bg-gray-100 px-1">npm run companion -- pair --server {origin}</code> and enter the code below.
        </li>
        <li>Allow what it may do (below). A new computer may do nothing.</li>
        <li>
          Approve folders <b>on the computer</b>: <code className="rounded bg-gray-100 px-1">npm run companion -- folders add &quot;C:\Users\you\Documents\Invoices&quot; --write</code>. This page can remove folders but never add them.
        </li>
        <li>
          Start it: <code className="rounded bg-gray-100 px-1">npm run companion -- run</code>. It works only while this runs.
        </li>
      </ol>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <Badge tone={hasDevice ? "green" : "gray"}>{hasDevice ? "A computer is paired" : "No computer paired"}</Badge>
        <Badge tone={ai.local ? "green" : "gray"}>{ai.local ? "Self-hosted AI model configured" : "No self-hosted AI model"}</Badge>
        <Badge tone={ai.cloud ? "blue" : "gray"}>{ai.cloud ? "Cloud AI available (only where you allow it)" : "Cloud AI off on this server"}</Badge>
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Without AI, plans come from simple rules and summaries are made on your computer from the first lines of each file. Screen viewing, mouse and keyboard control are not available in this version.
      </p>
    </Card>
  );
}

function PairCard({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<{ deviceName: string; platform: string; version: string; startedAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function check() {
    setError(null);
    setDone(null);
    const r = await api<{ preview: NonNullable<typeof preview> }>("/api/companion/pair/confirm", { body: { code, confirm: false } });
    if (r.ok) setPreview(r.data.preview);
    else setError(r.error.message);
  }
  async function confirm() {
    const r = await api<{ paired: { deviceName: string } }>("/api/companion/pair/confirm", { body: { code, confirm: true } });
    if (!r.ok) return setError(r.error.message);
    setDone(`“${r.data.paired.deviceName}” is paired. It has no permissions yet.`);
    setPreview(null);
    setCode("");
    onPaired();
  }
  return (
    <Card title="Pair a computer">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="pair-code" hint="Shown by the companion on your computer; valid for 10 minutes, once.">
            Pairing code
          </Label>
          <Input id="pair-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-2345" maxLength={9} className="w-40 font-mono" />
        </div>
        <Button variant="secondary" onClick={() => void check()} disabled={code.replace(/-/g, "").length !== 8}>
          Check
        </Button>
      </div>
      {preview && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p>
            Pair <b>{preview.deviceName}</b> ({PLATFORM[preview.platform] ?? preview.platform}, companion {preview.version}, started {timeAgo(preview.startedAt)})? Only pair a computer you are sitting at.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void confirm()}>
              Yes, pair it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {done && <Alert tone="green">{done}</Alert>}
    </Card>
  );
}

function DeviceCard({ device: d, capabilities, onChange }: { device: DeviceView; capabilities: CapabilityInfo[]; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revoked = d.status === "revoked";

  async function send(path: string, init: { method?: string; body?: unknown }) {
    setBusy(true);
    setError(null);
    const r = await api(path, init);
    setBusy(false);
    if (!r.ok) setError(r.error.message);
    onChange();
  }
  const toggleCap = (id: string, on: boolean) => send(`/api/companion/devices/${d.id}`, { method: "PATCH", body: { capabilities: on ? [...d.capabilities, id] : d.capabilities.filter((c) => c !== id) } });

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {d.name}
          <span className="text-xs font-normal text-gray-500">
            {PLATFORM[d.platform] ?? d.platform} · v{d.version}
          </span>
          {revoked ? <Badge tone="gray">Revoked</Badge> : <Badge tone={d.online ? "green" : "gray"}>{d.online ? "Online" : d.lastSeenAt ? `Offline · seen ${timeAgo(d.lastSeenAt)}` : "Never connected"}</Badge>}
          {d.stopped && !revoked && <Badge tone="red">Emergency stop on</Badge>}
        </span>
      }
      actions={
        !revoked && (
          <div className="flex gap-2">
            {d.stopped ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void send(`/api/companion/devices/${d.id}/stop`, { body: { action: "clear" } })}>
                Clear stop
              </Button>
            ) : (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void send(`/api/companion/devices/${d.id}/stop`, { body: { action: "stop" } })}>
                Stop
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (confirm(`Remove “${d.name}”? Its token stops working and its unfinished tasks are cancelled. To use it again, pair it again.`)) void send(`/api/companion/devices/${d.id}`, { method: "DELETE" });
              }}
            >
              Revoke
            </Button>
          </div>
        )
      }
    >
      {revoked ? (
        <p className="text-sm text-gray-500">This computer can no longer connect. Pair it again to use it.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-semibold text-gray-700">What it may do (off by default)</div>
            <ul className="space-y-1.5 text-sm">
              {capabilities.map((c) => (
                <li key={c.id}>
                  <label className={`flex items-start gap-2 ${c.implemented ? "" : "text-gray-400"}`}>
                    <input type="checkbox" aria-label={c.label} className="mt-1" disabled={!c.implemented || busy} checked={d.capabilities.includes(c.id as never)} onChange={(e) => void toggleCap(c.id, e.target.checked)} />
                    <span>
                      {c.label}
                      {!c.implemented && <span className="ml-1 text-xs">(not available yet)</span>}
                      {c.implemented && c.sideEffects && <span className="ml-1 text-xs text-gray-500">(each change asks for your approval)</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-4 mb-2 text-xs font-semibold text-gray-700">AI for this computer&apos;s files</div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" aria-label="Send short excerpts to this server AI" className="mt-1" disabled={busy} checked={d.aiExcerptsAllowed} onChange={(e) => void send(`/api/companion/devices/${d.id}`, { method: "PATCH", body: { aiExcerptsAllowed: e.target.checked } })} />
              <span>Send short excerpts (first 1,500 characters, ID numbers masked) to this server&apos;s AI for better summaries and command explanations</span>
            </label>
            <label className={`mt-1 flex items-start gap-2 text-sm ${d.aiExcerptsAllowed ? "" : "text-gray-400"}`}>
              <input type="checkbox" aria-label="Also allow cloud AI" className="mt-1" disabled={busy || !d.aiExcerptsAllowed} checked={d.cloudAiAllowed} onChange={(e) => void send(`/api/companion/devices/${d.id}`, { method: "PATCH", body: { cloudAiAllowed: e.target.checked } })} />
              <span>…also to cloud AI (Google Gemini) when no self-hosted model is available</span>
            </label>
            <p className="mt-1 text-xs text-gray-500">Local AI on this computer: {d.localAi === "available" ? "Ollama detected (not used by this version)" : "not detected"}.</p>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold text-gray-700">Folders approved on the computer</div>
            {d.folders.length === 0 ? (
              <p className="text-sm text-gray-500">None. Add folders on the computer with “folders add”.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {d.folders.map((f) => (
                  <li key={f.id} className="flex items-start justify-between gap-2 rounded-lg border border-gray-100 p-2">
                    <span className="min-w-0">
                      <span className="font-medium">{f.label}</span> {f.revoked ? <Badge tone="gray">revoked</Badge> : f.access.map((a) => <Badge key={a} tone={a === "read" ? "blue" : "amber"}>{a}</Badge>)}
                      <span className="block truncate font-mono text-xs text-gray-500">{f.displayPath}</span>
                    </span>
                    {!f.revoked && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void send(`/api/companion/devices/${d.id}/folders/${f.id}`, { method: "DELETE" })}>
                        Remove
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}

const EXAMPLES = ["Summarise the PDFs in Invoices", "Organise Downloads by type", "Create an Excel report of the invoices in Invoices", "Run the tests in my-app", "Undo the last organise"];

function AskCard({ devices }: { devices: DeviceView[] }) {
  const [deviceId, setDeviceId] = useState(devices[0]!.id);
  const [request, setRequest] = useState("");
  const [reply, setReply] = useState<PlanReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function plan() {
    setBusy(true);
    setError(null);
    const r = await api<PlanReply>("/api/agent/plan", { body: { deviceId, request } });
    setBusy(false);
    if (r.ok) setReply(r.data);
    else setError(r.error.message);
  }
  async function run(p: Plan) {
    setBusy(true);
    const r = await api<{ task: { id: string } }>("/api/agent/tasks", { body: { deviceId, taskType: p.taskType, input: p.input, idempotencyKey: `plan-${crypto.randomUUID()}` } });
    setBusy(false);
    if (r.ok) router.push(`/dashboard/tasks/${r.data.task.id}`);
    else setError(r.error.message + ((r.error.details as { missing?: string[] } | undefined)?.missing ? `: ${(r.error.details as { missing: string[] }).missing.join("; ")}` : ""));
  }
  return (
    <Card title="Ask your computer to do something">
      <div className="space-y-3">
        {devices.length > 1 && (
          <div>
            <Label htmlFor="ask-device">Computer</Label>
            <Select id="ask-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label htmlFor="ask-text" hint="Only what you type here is planned. Nothing runs until you press Run, and changes still need your approval.">
            What should it do?
          </Label>
          <Input id="ask-text" value={request} onChange={(e) => setRequest(e.target.value)} maxLength={500} placeholder={EXAMPLES[0]} onKeyDown={(e) => e.key === "Enter" && request.trim().length >= 3 && void plan()} />
          <div className="mt-1 flex flex-wrap gap-1">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50" onClick={() => setRequest(x)}>
                {x}
              </button>
            ))}
          </div>
        </div>
        <Button onClick={() => void plan()} disabled={busy || request.trim().length < 3}>
          Show the plan
        </Button>
        {reply && !reply.ok && <Alert tone="amber">{reply.question}</Alert>}
        {reply?.ok && (
          <div className="rounded-lg border border-gray-200 p-3 text-sm">
            <p className="font-medium text-gray-900">{reply.plan.explanation}</p>
            <ol className="mt-2 list-decimal pl-5 text-gray-700">
              {reply.plan.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="mt-1 text-xs text-gray-500">Planned by {reply.engine.provider === "rules" ? "rules (no AI)" : reply.engine.provider === "local" ? "the self-hosted model" : "Gemini"}; checked against your folders and permissions.</p>
            {reply.plan.missing.length > 0 ? (
              <Alert tone="amber">
                Missing before this can run:
                <ul className="list-disc pl-5">
                  {reply.plan.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </Alert>
            ) : (
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void run(reply.plan)} disabled={busy}>
                  Run
                </Button>
                <Link href="/dashboard/tasks" className="self-center text-xs text-gray-500 hover:underline">
                  All tasks
                </Link>
              </div>
            )}
          </div>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </Card>
  );
}
