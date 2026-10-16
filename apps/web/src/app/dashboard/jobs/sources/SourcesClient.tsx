"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { JobSourceView } from "@/server/jobs/types";

const STATUS: Record<JobSourceView["lastStatus"], { tone: "green" | "red" | "amber" | "gray"; text: string }> = {
  never: { tone: "gray", text: "Not read yet" },
  ok: { tone: "green", text: "OK" },
  error: { tone: "red", text: "Error" },
  rate_limited: { tone: "amber", text: "Asked to slow down" },
  not_found: { tone: "red", text: "Board not found" },
};

export function SourcesClient({ sources }: { sources: JobSourceView[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsDetails, setNeedsDetails] = useState(false);

  async function follow(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy("follow");
    const res = await api<JobSourceView>("/api/jobs/sources", { body: { sourceType: f.get("sourceType"), sourceKey: String(f.get("sourceKey") ?? ""), region: f.get("region") || undefined } });
    setBusy(null);
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message });
    setMsg(res.data.lastStatus === "ok" ? { tone: "green", text: `Following ${res.data.displayName ?? res.data.sourceKey}: ${res.data.jobCount} open job(s).` } : { tone: "red", text: res.data.lastError ?? "The board could not be read." });
    router.refresh();
  }

  async function addJob(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, string> = { url: String(f.get("url") ?? "").trim() };
    for (const k of ["title", "employer", "location", "employmentType", "description"]) {
      const v = String(f.get(k) ?? "").trim();
      if (v) body[k] = v;
    }
    setBusy("add");
    const res = await api<{ id: string }>("/api/jobs", { body });
    setBusy(null);
    if (!res.ok) {
      if (res.error.code === "job_source_invalid_source" && /title/i.test(res.error.message)) setNeedsDetails(true);
      return setMsg({ tone: "red", text: res.error.message });
    }
    router.push(`/dashboard/jobs/${res.data.id}`);
  }

  async function act(id: string, what: "refresh" | "remove") {
    setBusy(id);
    const res = what === "refresh" ? await api<JobSourceView>(`/api/jobs/sources/${id}/refresh`, { method: "POST" }) : await api(`/api/jobs/sources/${id}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) setMsg({ tone: "red", text: res.error.message });
    router.refresh();
  }

  return (
    <>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Follow a company's job board">
          <form onSubmit={(e) => void follow(e)} className="space-y-2">
            <div>
              <Label htmlFor="sourceType">Board</Label>
              <Select id="sourceType" name="sourceType" defaultValue="greenhouse">
                <option value="greenhouse">Greenhouse (boards.greenhouse.io/NAME)</option>
                <option value="lever">Lever (jobs.lever.co/NAME)</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="sourceKey" hint="(the NAME part of the jobs link)">Company board name</Label>
              <Input id="sourceKey" name="sourceKey" required maxLength={80} pattern="[A-Za-z0-9][A-Za-z0-9_\-]*" placeholder="e.g. acme" />
            </div>
            <div>
              <Label htmlFor="region" hint="(Lever only)">Region</Label>
              <Select id="region" name="region" defaultValue="global">
                <option value="global">Global (jobs.lever.co)</option>
                <option value="eu">EU (jobs.eu.lever.co)</option>
              </Select>
            </div>
            <Button type="submit" disabled={busy !== null}>
              {busy === "follow" ? "Reading the board…" : "Follow"}
            </Button>
          </form>
        </Card>

        <Card title="Add one job by link">
          <form onSubmit={(e) => void addJob(e)} className="space-y-2">
            <div>
              <Label htmlFor="url">Job link (https)</Label>
              <Input id="url" name="url" type="url" required maxLength={2000} placeholder="https://…" />
            </div>
            <p className="text-xs text-gray-500">Greenhouse and Lever links are read through their public APIs. For any other site, fill in the details below — the page itself is not fetched.</p>
            <details open={needsDetails}>
              <summary className="cursor-pointer text-sm text-gray-700">Job details (needed for other sites)</summary>
              <div className="mt-2 space-y-2">
                <Input name="title" maxLength={300} placeholder="Job title" aria-label="Job title" />
                <Input name="employer" maxLength={200} placeholder="Employer" aria-label="Employer" />
                <Input name="location" maxLength={300} placeholder="Location" aria-label="Location" />
                <Input name="employmentType" maxLength={80} placeholder="Employment type" aria-label="Employment type" />
                <textarea name="description" maxLength={30000} rows={6} placeholder="Paste the job description" aria-label="Job description" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
              </div>
            </details>
            <Button type="submit" disabled={busy !== null}>
              {busy === "add" ? "Adding…" : "Add job"}
            </Button>
          </form>
        </Card>
      </div>

      <Card title={`Boards you follow (${sources.length})`}>
        {sources.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <span className="font-medium">{s.displayName ?? s.sourceKey}</span>{" "}
                  <span className="text-xs text-gray-500">
                    {s.sourceType === "greenhouse" ? "Greenhouse" : `Lever${s.region === "eu" ? " EU" : ""}`} · {s.sourceKey} · {s.jobCount} open
                    {s.lastFetchedAt ? ` · read ${new Date(s.lastFetchedAt).toLocaleString("en-IN")}` : ""}
                  </span>{" "}
                  <Badge tone={STATUS[s.lastStatus].tone}>{STATUS[s.lastStatus].text}</Badge>
                  {s.lastError && <div className="text-xs text-red-700">{s.lastError}</div>}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" disabled={busy !== null || s.refreshAvailableIn > 0} onClick={() => void act(s.id, "refresh")} title={s.refreshAvailableIn > 0 ? "Each board is read at most once every 10 minutes" : undefined}>
                    {busy === s.id ? "Reading…" : s.refreshAvailableIn > 0 ? `Refresh in ${Math.ceil(s.refreshAvailableIn / 60)} min` : "Refresh"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void act(s.id, "remove")}>
                    Stop following
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
