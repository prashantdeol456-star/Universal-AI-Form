"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Input, Label } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { JobPreferencesView } from "@/server/jobs/types";

const split = (s: FormDataEntryValue | null) =>
  String(s ?? "")
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const num = (s: FormDataEntryValue | null) => {
  const t = String(s ?? "").trim();
  return t === "" ? null : Number(t);
};

export function PreferencesForm({ initial }: { initial: JobPreferencesView }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      roles: split(f.get("roles")),
      locations: split(f.get("locations")),
      workArrangements: f.getAll("workArrangements").map(String),
      employmentTypes: split(f.get("employmentTypes")),
      industries: split(f.get("industries")),
      experienceMin: num(f.get("experienceMin")),
      experienceMax: num(f.get("experienceMax")),
      salaryMin: num(f.get("salaryMin")),
      salaryMax: num(f.get("salaryMax")),
      salaryCurrency: String(f.get("salaryCurrency") ?? "").trim().toUpperCase() || null,
    };
    setBusy(true);
    const res = await api("/api/jobs/preferences", { method: "PUT", body });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "red", text: res.error.message });
    setMsg({ tone: "green", text: "Saved. Fit scores were recalculated." });
    router.refresh();
  }

  return (
    <Card>
      <form onSubmit={(e) => void save(e)} className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="roles" hint="(comma separated)">Preferred roles</Label>
          <Input id="roles" name="roles" defaultValue={initial.roles.join(", ")} placeholder="e.g. Project Manager, Program Manager" />
        </div>
        <div>
          <Label htmlFor="locations" hint="(comma separated; “Remote” allowed)">Preferred locations</Label>
          <Input id="locations" name="locations" defaultValue={initial.locations.join(", ")} placeholder="e.g. Pune, Bengaluru, Remote" />
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-gray-700">Work arrangement</legend>
          {(["remote", "hybrid", "onsite"] as const).map((w) => (
            <label key={w} className="mr-3 text-sm">
              <input type="checkbox" name="workArrangements" value={w} defaultChecked={initial.workArrangements.includes(w)} /> {w === "onsite" ? "On-site" : w[0]!.toUpperCase() + w.slice(1)}
            </label>
          ))}
        </fieldset>
        <div>
          <Label htmlFor="employmentTypes" hint="(comma separated)">Employment types</Label>
          <Input id="employmentTypes" name="employmentTypes" defaultValue={initial.employmentTypes.join(", ")} placeholder="e.g. Full-time, Contract" />
        </div>
        <div className="flex gap-2">
          <div>
            <Label htmlFor="experienceMin">Experience from (years)</Label>
            <Input id="experienceMin" name="experienceMin" type="number" min={0} max={60} step={0.5} defaultValue={initial.experienceMin ?? ""} />
          </div>
          <div>
            <Label htmlFor="experienceMax">to</Label>
            <Input id="experienceMax" name="experienceMax" type="number" min={0} max={60} step={0.5} defaultValue={initial.experienceMax ?? ""} />
          </div>
        </div>
        <div className="flex gap-2">
          <div>
            <Label htmlFor="salaryMin" hint="(optional)">Salary from</Label>
            <Input id="salaryMin" name="salaryMin" type="number" min={0} defaultValue={initial.salaryMin ?? ""} />
          </div>
          <div>
            <Label htmlFor="salaryMax">to</Label>
            <Input id="salaryMax" name="salaryMax" type="number" min={0} defaultValue={initial.salaryMax ?? ""} />
          </div>
          <div>
            <Label htmlFor="salaryCurrency">Currency</Label>
            <Input id="salaryCurrency" name="salaryCurrency" maxLength={3} defaultValue={initial.salaryCurrency ?? ""} placeholder="INR" />
          </div>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="industries" hint="(comma separated)">Preferred industries</Label>
          <Input id="industries" name="industries" defaultValue={initial.industries.join(", ")} placeholder="e.g. Logistics, Fintech" />
        </div>
        <p className="text-xs text-gray-500 sm:col-span-2">
          Roles, locations, work arrangement and employment type count in the fit score when you set them. Experience range, salary and industries are kept for your reference and filtering; they are not
          part of the score.
        </p>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save preferences"}
          </Button>
        </div>
      </form>
      {msg && <div className="mt-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
    </Card>
  );
}
