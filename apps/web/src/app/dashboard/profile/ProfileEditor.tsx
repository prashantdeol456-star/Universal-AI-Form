"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import {
  CATEGORY_LABELS,
  formatFieldValue,
  PROFILE_CATEGORIES,
  PROFILE_FIELDS,
  type FieldInputType,
  type ProfileCategory,
} from "@ufa/shared";
import { Alert, Badge, Button, Card, Input, Label, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { CustomFieldDefView, HistoryEntry, ProfileFieldView } from "@/server/profile/types";

interface RowDef {
  key: string;
  label: string;
  labelHi?: string;
  input: FieldInputType;
  options?: readonly string[];
  sensitive: boolean;
  group?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  user_input: "You",
  chat: "AI chat",
  document: "Document",
  local_ai: "Local AI",
  gemini: "Gemini",
  application: "Application",
  admin: "Admin",
};

function customToRow(c: CustomFieldDefView): RowDef {
  const input: FieldInputType =
    c.dataType === "number" ? "number" : c.dataType === "date" ? "date" : c.dataType === "boolean" ? "yes_no" : c.dataType === "select" ? "select" : "text";
  return { key: c.fieldKey, label: c.label, input, options: c.options, sensitive: c.isSensitive };
}

export function ProfileEditor({ fields, customFields }: { fields: ProfileFieldView[]; customFields: CustomFieldDefView[] }) {
  const [tab, setTab] = useState<ProfileCategory>("personal");
  const byKey = useMemo(() => new Map(fields.map((f) => [f.fieldKey, f])), [fields]);

  const rows: RowDef[] =
    tab === "custom"
      ? customFields.map(customToRow)
      : PROFILE_FIELDS.filter((d) => d.category === tab).map((d) => ({
          key: d.key,
          label: d.label.en,
          labelHi: d.label.hi,
          input: d.input,
          options: d.options,
          sensitive: d.sensitivity !== "normal",
          group: d.group,
        }));

  const countFor = (c: ProfileCategory) =>
    c === "custom" ? customFields.filter((cf) => byKey.has(cf.fieldKey)).length : fields.filter((f) => f.fieldKey.startsWith(`${c}.`)).length;

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white p-1">
        {PROFILE_CATEGORIES.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={tab === c}
            onClick={() => setTab(c)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${tab === c ? "bg-brand-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
          >
            {CATEGORY_LABELS[c].en}
            <span className={`ml-1.5 text-xs ${tab === c ? "text-white/80" : "text-gray-400"}`}>{countFor(c)}</span>
          </button>
        ))}
      </div>

      {tab === "bank" && (
        <Alert tone="amber">Bank details are encrypted and are never shared with cyber cafés, even during an approved access session.</Alert>
      )}

      <Card title={`${CATEGORY_LABELS[tab].en} · ${CATEGORY_LABELS[tab].hi}`}>
        {rows.length === 0 && tab === "custom" ? (
          <p className="text-sm text-gray-500">No custom fields yet. Add anything a form asks that is not listed elsewhere.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <li key={r.key}>
                {r.group && r.group !== rows[i - 1]?.group && (
                  <div className="pt-4 pb-1 text-xs font-semibold tracking-wide text-gray-400 uppercase">{r.label.split(" — ")[0]}</div>
                )}
                <FieldRow def={r} field={byKey.get(r.key)} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {tab === "custom" && <AddCustomField />}
    </div>
  );
}

function ValueInput({ def, defaultValue }: { def: RowDef; defaultValue: string }) {
  const common = { name: "value", defaultValue, required: true, autoFocus: true, "aria-label": def.label };
  if (def.input === "select" && def.options?.length)
    return (
      <Select {...common}>
        <option value="">Select…</option>
        {def.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </Select>
    );
  if (def.input === "yes_no")
    return (
      <Select {...common}>
        <option value="">Select…</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </Select>
    );
  if (def.input === "textarea")
    return (
      <textarea
        {...common}
        rows={4}
        maxLength={500}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-xs placeholder:text-gray-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
      />
    );
  return <Input {...common} type={def.input === "date" ? "date" : def.input === "number" ? "text" : "text"} inputMode={def.input === "number" ? "decimal" : undefined} autoComplete="off" />;
}

function FieldRow({ def, field }: { def: RowDef; field?: ProfileFieldView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{ value: string; current: string } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const label = def.group ? def.label.split(" — ")[1] ?? def.label : def.label;
  const labelHi = def.labelHi && def.group ? def.labelHi.split(" — ")[1] : def.labelHi;

  async function save(value: string, confirmOverwrite = false) {
    setBusy(true);
    setError(null);
    const res = await api<{ status: string }>("/api/profile/fields", { method: "PUT", body: { fieldKey: def.key, value, confirmOverwrite } });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 409) {
        const d = res.error.details as { currentValue?: string } | undefined;
        setPendingOverwrite({ value, current: d?.currentValue ?? "" });
        return;
      }
      setError(res.error.message);
      return;
    }
    setPendingOverwrite(null);
    setEditing(false);
    setRevealed(null);
    router.refresh();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void save(String(new FormData(e.currentTarget).get("value") ?? ""));
  }

  async function reveal() {
    if (revealed !== null) return setRevealed(null);
    const res = await api<{ value: string }>("/api/profile/reveal", { body: { fieldKey: def.key } });
    if (res.ok) setRevealed(res.data.value);
    else setError(res.error.message);
  }

  async function toggleHistory() {
    if (history) return setHistory(null);
    const res = await api<{ history: HistoryEntry[] }>(`/api/profile/history?key=${encodeURIComponent(def.key)}`);
    if (res.ok) setHistory(res.data.history);
    else setError(res.error.message);
  }

  async function remove() {
    if (!window.confirm(`Remove "${label}" from your profile? The change is kept in your history.`)) return;
    const res = await fetch(`/api/profile/fields?key=${encodeURIComponent(def.key)}`, { method: "DELETE" });
    if (res.ok) router.refresh();
    else setError("Could not remove this value");
  }

  const display = revealed ?? (field ? (field.masked ? field.value : formatFieldValue(field.fieldKey, field.value)) : undefined);

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-48">
          <div className="text-sm font-medium text-gray-900">{label}</div>
          {labelHi && <div className="text-xs text-gray-400">{labelHi}</div>}
        </div>

        {!editing && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
            {field ? (
              <>
                <span className="min-w-0 truncate text-sm text-gray-800">{display}</span>
                {field.verified ? <Badge tone="green">Verified</Badge> : <Badge tone="amber">Unverified</Badge>}
                {field.sourceDocumentId ? (
                  <Link href={`/dashboard/documents/${field.sourceDocumentId}`} title="Open the source document" className="hover:opacity-80">
                    <Badge>{SOURCE_LABEL[field.source] ?? field.source} ↗</Badge>
                  </Link>
                ) : (
                  <Badge>{SOURCE_LABEL[field.source] ?? field.source}</Badge>
                )}
                {field.confidence !== null && field.confidence < 1 && <Badge tone="blue">{Math.round(field.confidence * 100)}%</Badge>}
              </>
            ) : (
              <span className="text-sm text-gray-400">Not provided</span>
            )}
            <div className="flex gap-1">
              {field && !field.verified && !field.masked && (
                <Button size="sm" disabled={busy} onClick={() => save(field.value)}>
                  Confirm
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                {field ? "Edit" : "Add"}
              </Button>
              {field?.masked && (
                <Button size="sm" variant="ghost" onClick={reveal}>
                  {revealed !== null ? "Hide" : "Show"}
                </Button>
              )}
              {field && (
                <>
                  <Button size="sm" variant="ghost" onClick={toggleHistory}>
                    History
                  </Button>
                  <Button size="sm" variant="ghost" onClick={remove} aria-label={`Remove ${label}`}>
                    Remove
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {editing && (
        <form onSubmit={onSubmit} className="mt-2 flex flex-wrap items-center gap-2">
          <div className="min-w-56 flex-1">
            <ValueInput def={def} defaultValue={field && !field.masked ? field.value : revealed ?? ""} />
          </div>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); setPendingOverwrite(null); }}>
            Cancel
          </Button>
        </form>
      )}

      {pendingOverwrite && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          You currently have <strong>{pendingOverwrite.current}</strong> saved and verified. Update it to <strong>{def.sensitive ? "the new value" : pendingOverwrite.value}</strong>?
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => save(pendingOverwrite.value, true)}>
              Yes, update
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setPendingOverwrite(null)}>
              Keep current
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2">
          <Alert>{error}</Alert>
        </div>
      )}

      {history && (
        <div className="mt-2 rounded-lg bg-gray-50 p-3">
          <div className="mb-1 text-xs font-semibold text-gray-500">Change history</div>
          {history.length === 0 ? (
            <p className="text-xs text-gray-500">No history.</p>
          ) : (
            <ul className="space-y-1 text-xs text-gray-700">
              {history.map((h, i) => (
                <li key={i}>
                  <time className="text-gray-400">{new Date(h.createdAt).toLocaleString("en-IN")}</time> · {h.changeType}
                  {h.oldValue !== null && h.changeType !== "VERIFY" && <> · from “{h.oldValue}”</>}
                  {h.newValue !== null && h.changeType !== "VERIFY" && <> to “{h.newValue}”</>}
                  {h.newSource && <> · via {SOURCE_LABEL[h.newSource] ?? h.newSource}</>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AddCustomField() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [dataType, setDataType] = useState("text");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const options = String(form.get("options") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    setError(null);
    const res = await api("/api/profile/custom-fields", {
      body: {
        label: form.get("label"),
        dataType,
        options,
        isSensitive: form.get("isSensitive") === "on",
        value: String(form.get("value") ?? "") || undefined,
      },
    });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    formEl.reset();
    setDataType("text");
    router.refresh();
  }

  return (
    <Card title="Add a custom field">
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
        {error && (
          <div className="sm:col-span-2">
            <Alert>{error}</Alert>
          </div>
        )}
        <div>
          <Label htmlFor="cf-label">Field name</Label>
          <Input id="cf-label" name="label" required maxLength={120} placeholder="e.g. NCC Certificate Grade" />
        </div>
        <div>
          <Label htmlFor="cf-type">Type</Label>
          <Select id="cf-type" value={dataType} onChange={(e) => setDataType(e.target.value)}>
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="boolean">Yes / No</option>
            <option value="select">Choice list</option>
          </Select>
        </div>
        {dataType === "select" && (
          <div className="sm:col-span-2">
            <Label htmlFor="cf-options" hint="(comma separated)">Options</Label>
            <Input id="cf-options" name="options" required placeholder="A, B, C" />
          </div>
        )}
        <div>
          <Label htmlFor="cf-value" hint="(optional)">Value</Label>
          <Input id="cf-value" name="value" type={dataType === "date" ? "date" : "text"} />
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-gray-700">
          <input type="checkbox" name="isSensitive" className="h-4 w-4 rounded border-gray-300" />
          Sensitive (encrypt and mask)
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add field"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
