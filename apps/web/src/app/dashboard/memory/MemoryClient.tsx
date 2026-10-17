"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button, Card, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import { timeAgo } from "@/lib/labels";

interface Pref {
  key: string;
  value: string;
  source: string;
  updatedAt: string;
}
interface Workflow {
  id: string;
  name: string;
  purpose: string | null;
  taskType: string;
  status: "draft" | "approved" | "disabled";
  steps: string[];
  requiredCapabilities: string[];
  successCount: number;
  failureCount: number;
  lastUsedAt: string | null;
  input: Record<string, unknown>;
}
interface Feedback {
  id: string;
  taskId: string;
  title: string;
  correct: boolean;
  note: string | null;
  scope: string;
  wrongStep: string | null;
  createdAt: string;
}
interface Device {
  id: string;
  name: string;
  folders: Array<{ id: string; label: string }>;
}

export function MemoryClient({ prefs, keys, workflows, feedback, devices }: { prefs: Pref[]; keys: Record<string, { label: string; values: string[] | null }>; workflows: Workflow[]; feedback: Feedback[]; devices: Device[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");

  async function send(path: string, init: { method?: string; body?: unknown }, then?: (d: unknown) => void) {
    setError(null);
    const r = await api(path, init);
    if (!r.ok) return setError(r.error.message);
    then?.(r.data);
    router.refresh();
  }
  const outputFolders = devices.flatMap((d) => d.folders.map((f) => ({ ...f, device: d.name })));
  const prefLabel = (p: Pref) => (p.key === "output_folder_id" ? (outputFolders.find((f) => f.id === p.value)?.label ?? "a folder that is no longer approved") : p.value);

  return (
    <div className="space-y-6">
      {error && <Alert>{error}</Alert>}
      <Card title="Preferences">
        <ul className="space-y-2 text-sm">
          {Object.entries(keys).map(([key, k]) => {
            const p = prefs.find((x) => x.key === key);
            const options = k.values ?? outputFolders.map((f) => f.id);
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {k.label}
                  {p && <span className="ml-2 text-xs text-gray-500">{p.source === "feedback" ? "from your feedback" : "set by you"} · {timeAgo(p.updatedAt)}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <Select aria-label={k.label} value={p?.value ?? ""} onChange={(e) => e.target.value && void send("/api/agent/preferences", { method: "PUT", body: { key, value: e.target.value } })} className="w-48">
                    <option value="">Not set</option>
                    {options.map((v) => (
                      <option key={v} value={v}>
                        {key === "output_folder_id" ? `${outputFolders.find((f) => f.id === v)?.label} (${outputFolders.find((f) => f.id === v)?.device})` : v}
                      </option>
                    ))}
                  </Select>
                  {p && (
                    <Button size="sm" variant="ghost" onClick={() => void send(`/api/agent/preferences?key=${key}`, { method: "DELETE" })}>
                      Forget
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {prefs.some((p) => p.key === "output_folder_id") && <p className="mt-2 text-xs text-gray-500">Report folder: {prefLabel(prefs.find((p) => p.key === "output_folder_id")!)}</p>}
      </Card>

      <Card
        title="Saved workflows"
        actions={
          devices.length > 1 && (
            <Select aria-label="Computer" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="w-48">
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )
        }
      >
        {workflows.length === 0 ? (
          <p className="text-sm text-gray-500">None yet. After a computer task finishes, use “Save as workflow” on its page. Saved workflows start as drafts you review here.</p>
        ) : (
          <ul className="space-y-3">
            {workflows.map((w) => (
              <li key={w.id} className="rounded-lg border border-gray-100 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-gray-900">
                    {w.name} <Badge tone={w.status === "approved" ? "green" : w.status === "draft" ? "amber" : "gray"}>{w.status === "draft" ? "Draft — review it" : w.status}</Badge>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {w.status !== "approved" && (
                      <Button size="sm" variant="secondary" onClick={() => void send(`/api/agent/workflows/${w.id}`, { method: "PATCH", body: { status: "approved" } })}>
                        Approve for reuse
                      </Button>
                    )}
                    {w.status === "approved" && (
                      <>
                        <Button size="sm" disabled={!deviceId} onClick={() => void send(`/api/agent/workflows/${w.id}/run`, { body: { deviceId } }, (d) => router.push(`/dashboard/tasks/${(d as { task: { id: string } }).task.id}`))}>
                          Run
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void send(`/api/agent/workflows/${w.id}`, { method: "PATCH", body: { status: "disabled" } })}>
                          Disable
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const name = prompt("New name", w.name);
                        if (name?.trim()) void send(`/api/agent/workflows/${w.id}`, { method: "PATCH", body: { name: name.trim() } });
                      }}
                    >
                      Rename
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => confirm(`Delete “${w.name}”?`) && void send(`/api/agent/workflows/${w.id}`, { method: "DELETE" })}>
                      Delete
                    </Button>
                  </span>
                </div>
                {w.purpose && <p className="mt-1 text-xs text-gray-500">From: {w.purpose}</p>}
                <ol className="mt-1 list-decimal pl-5 text-gray-700">
                  {w.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p className="mt-1 text-xs text-gray-500">
                  Options: {Object.entries(w.input).filter(([k]) => !/Id$/.test(k)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") || "any" : String(v ?? "any")}`).join(", ") || "none"} · needs: {w.requiredCapabilities.join(", ")} · {w.successCount} succeeded, {w.failureCount} failed or cancelled
                  {w.lastUsedAt ? ` · last used ${timeAgo(w.lastUsedAt)}` : ""}
                </p>
                <p className="mt-1 text-xs text-gray-500">Running it creates a normal task: folders and permissions are checked again and every change still asks for your approval.</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Your feedback on tasks">
        {feedback.length === 0 ? (
          <p className="text-sm text-gray-500">None yet. Each finished task page asks “Was this correct?”.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm">
            {feedback.map((f) => (
              <li key={f.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <Link href={`/dashboard/tasks/${f.taskId}`} className="text-brand-700 hover:underline">
                    {f.title}
                  </Link>{" "}
                  <Badge tone={f.correct ? "green" : "red"}>{f.correct ? "correct" : "not correct"}</Badge> <Badge tone="gray">{f.scope === "future" ? "remember" : "this time only"}</Badge>
                  {f.wrongStep && <span className="ml-1 text-xs text-gray-500">step: {f.wrongStep}</span>}
                  {f.note && <span className="block text-gray-700">{f.note}</span>}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void send(`/api/agent/feedback/${f.id}`, { method: "DELETE" })}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
