"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconBookmark, IconTrash } from "@/components/icons";
import { Alert, Button, Input, Label } from "@/components/ui";
import { api } from "@/lib/api-client";

export function AddSavedForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <IconBookmark size={16} /> Save a form
      </Button>
    );
  }

  return (
    <form
      className="w-full space-y-3 rounded-2xl border border-gray-200 bg-white p-5 shadow-xs"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const r = await api<{ created: boolean }>("/api/saved-forms", { body: { name, url, notes: notes || null } });
        setBusy(false);
        if (!r.ok) return setError(r.error.message);
        if (!r.data.created) return setError("This page is already in your saved forms.");
        setOpen(false);
        setName("");
        setUrl("");
        setNotes("");
        router.refresh();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="sf-name">Name</Label>
          <Input id="sf-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="e.g. SSC CGL 2026 registration" />
        </div>
        <div>
          <Label htmlFor="sf-url">Page address</Label>
          <Input id="sf-url" value={url} onChange={(e) => setUrl(e.target.value)} required type="url" placeholder="https://…" />
        </div>
      </div>
      <div>
        <Label htmlFor="sf-notes" hint="(optional)">
          Notes
        </Label>
        <Input id="sf-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Last date, fee, documents needed…" />
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function EditNotes({ id, initial }: { id: string; initial: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(initial ?? "");
  if (!editing) {
    return (
      <button className="text-left text-xs text-gray-500 hover:text-gray-800" onClick={() => setEditing(true)}>
        {initial ? initial : <span className="text-brand-600">+ Add a note</span>}
      </button>
    );
  }
  return (
    <form
      className="flex gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        await api(`/api/saved-forms/${id}`, { method: "PATCH", body: { notes: notes.trim() || null } });
        setEditing(false);
        router.refresh();
      }}
    >
      <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} autoFocus aria-label="Notes" />
      <Button size="sm" type="submit">
        Save
      </Button>
    </form>
  );
}

export function RemoveSavedForm({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Remove ${name}`}
      onClick={async () => {
        if (!confirm(`Remove “${name}” from saved forms? Your application history is not affected.`)) return;
        await api(`/api/saved-forms/${id}`, { method: "DELETE" });
        router.refresh();
      }}
    >
      <IconTrash size={15} />
    </Button>
  );
}
