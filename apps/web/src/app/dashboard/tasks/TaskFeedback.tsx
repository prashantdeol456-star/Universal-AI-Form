"use client";

import Link from "next/link";
import { useState } from "react";
import { Alert, Button, Card, Input, Select } from "@/components/ui";
import { api } from "@/lib/api-client";

/**
 * "Was this correct?" for a finished task. "Remember for next time" may suggest one preference;
 * it is saved only when the user presses Save. Computer tasks can also be saved as a draft workflow.
 */
export function TaskFeedback({ taskId, steps, canSaveWorkflow, defaultName }: { taskId: string; steps: Array<{ key: string; title: string }>; canSaveWorkflow: boolean; defaultName: string }) {
  const [correct, setCorrect] = useState<boolean | null>(null);
  const [step, setStep] = useState("");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<"one_time" | "future">("one_time");
  const [sent, setSent] = useState(false);
  const [suggestion, setSuggestion] = useState<{ key: string; value: string; label: string } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wf, setWf] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const r = await api<{ suggestion: typeof suggestion }>(`/api/tasks/${taskId}/feedback`, { body: { correct, wrongStepKey: step || null, note: note || null, scope } });
    if (!r.ok) return setError(r.error.message);
    setSent(true);
    setSuggestion(r.data.suggestion);
  }
  async function savePreference() {
    if (!suggestion) return;
    const r = await api("/api/agent/preferences", { method: "PUT", body: { key: suggestion.key, value: suggestion.value, source: "feedback" } });
    if (r.ok) {
      setSaved(suggestion.label);
      setSuggestion(null);
    } else setError(r.error.message);
  }
  async function saveWorkflow() {
    const name = prompt("Name for this workflow", defaultName.slice(0, 100));
    if (!name?.trim()) return;
    const r = await api<{ id: string }>("/api/agent/workflows", { body: { taskId, name: name.trim() } });
    if (r.ok) setWf(r.data.id);
    else setError(r.error.message);
  }

  return (
    <Card title="Was this correct?">
      {sent ? (
        <div className="space-y-2 text-sm">
          <p className="text-gray-700">Thanks, your feedback is saved (see Agent memory). It does not train any AI model.</p>
          {suggestion && (
            <Alert tone="amber">
              Remember this for next time: <b>{suggestion.label}</b>?{" "}
              <Button size="sm" onClick={() => void savePreference()}>
                Save preference
              </Button>{" "}
              <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
                No
              </Button>
            </Alert>
          )}
          {scope === "future" && !suggestion && !saved && <p className="text-xs text-gray-500">No setting matched your note, so nothing was remembered beyond the note itself.</p>}
          {saved && <Alert tone="green">Saved: {saved}. Change or delete it in Agent memory.</Alert>}
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex gap-2">
            <Button size="sm" variant={correct === true ? "primary" : "secondary"} onClick={() => setCorrect(true)}>
              Yes
            </Button>
            <Button size="sm" variant={correct === false ? "primary" : "secondary"} onClick={() => setCorrect(false)}>
              No
            </Button>
          </div>
          {correct === false && (
            <Select aria-label="Which step was wrong" value={step} onChange={(e) => setStep(e.target.value)}>
              <option value="">Which step was wrong? (optional)</option>
              {steps.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </Select>
          )}
          {correct !== null && (
            <>
              <Input aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={correct ? "Anything to keep in mind? (optional)" : "What should be different? e.g. “use Markdown reports”"} />
              <label className="flex items-center gap-2 text-xs text-gray-700">
                <input type="radio" checked={scope === "one_time"} onChange={() => setScope("one_time")} /> Only this time
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-700">
                <input type="radio" checked={scope === "future"} onChange={() => setScope("future")} /> Remember for next time (you confirm before anything is saved as a setting)
              </label>
              <Button size="sm" onClick={() => void submit()}>
                Send feedback
              </Button>
            </>
          )}
        </div>
      )}
      {canSaveWorkflow && (
        <div className="mt-4 border-t border-gray-100 pt-3 text-sm">
          {wf ? (
            <p>
              Saved as a draft workflow. Review and approve it in{" "}
              <Link href="/dashboard/memory" className="text-brand-700 hover:underline">
                Agent memory
              </Link>
              .
            </p>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void saveWorkflow()}>
              Save as workflow
            </Button>
          )}
        </div>
      )}
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}
