"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api } from "@/lib/api-client";

/** Recomputes every fit score after the user updated their profile, documents or preferences. */
export function RematchButton() {
  const router = useRouter();
  const [state, setState] = useState<string | null>(null);
  async function run() {
    setState("Recalculating…");
    const res = await api<{ jobs: number }>("/api/jobs/rematch", { method: "POST" });
    setState(res.ok ? `Recalculated ${res.data.jobs} job(s).` : res.error.message);
    router.refresh();
  }
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" disabled={state === "Recalculating…"} onClick={() => void run()}>
        Recalculate scores
      </Button>
      {state && <span className="text-xs text-gray-500">{state}</span>}
    </div>
  );
}
