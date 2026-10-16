"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api-client";

export function SaveButton({ jobId, saved }: { jobId: string; saved: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    const res = await api(`/api/jobs/${jobId}/save`, { method: "PUT", body: { saved: !saved } });
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setError(null);
    router.refresh();
  }
  return (
    <div className="text-right">
      <Button size="sm" variant={saved ? "secondary" : "primary"} disabled={busy} onClick={() => void toggle()}>
        {saved ? "Saved ✓" : "Save"}
      </Button>
      {error && <div className="text-xs text-red-700">{error}</div>}
    </div>
  );
}
