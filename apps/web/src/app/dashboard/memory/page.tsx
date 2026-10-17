import { PageHeader, Card } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { listFeedback, listPreferences, listWorkflows, PREFERENCE_KEYS } from "@/server/companion/memory";
import { listDevices } from "@/server/companion/service";
import { env } from "@/server/env";
import { MemoryClient } from "./MemoryClient";

export default async function MemoryPage() {
  const user = await requirePageUser();
  if (!env().COMPANION_ENABLED) {
    return (
      <>
        <PageHeader title="Agent memory" />
        <Card>
          <p className="text-sm text-gray-700">Agent memory belongs to the local companion, which is switched off on this server.</p>
        </Card>
      </>
    );
  }
  const [prefs, workflows, feedback, devices] = await Promise.all([listPreferences(user), listWorkflows(user), listFeedback(user, null), listDevices(user)]);
  return (
    <>
      <PageHeader
        title="Agent memory"
        description="What the assistant remembers to work the way you like: a few preferences you confirmed, workflows you saved, and your feedback on tasks. It is stored for your account only, never used to train an AI model, and you can change or delete any of it. Remembered things never skip an approval."
      />
      <MemoryClient
        prefs={prefs.map((p) => ({ key: p.key, value: p.value, source: p.source, updatedAt: p.updated_at.toISOString() }))}
        keys={Object.fromEntries(Object.entries(PREFERENCE_KEYS).map(([k, v]) => [k, { label: v.label, values: v.values ? [...v.values] : null }]))}
        workflows={workflows.map((w) => ({
          id: w.id,
          name: w.name,
          purpose: w.purpose,
          taskType: w.task_type,
          status: w.status,
          steps: w.steps,
          requiredCapabilities: w.required_capabilities,
          successCount: w.success_count,
          failureCount: w.failure_count,
          lastUsedAt: w.last_used_at?.toISOString() ?? null,
          input: w.input_template,
        }))}
        feedback={feedback.map((f) => ({ id: f.id, taskId: f.task_id, title: f.title, correct: f.correct, note: f.note, scope: f.scope, wrongStep: f.wrong_step_key, createdAt: f.created_at.toISOString() }))}
        devices={devices.filter((d) => d.status === "active").map((d) => ({ id: d.id, name: d.name, folders: d.folders.filter((f) => !f.revoked && f.access.includes("write")).map((f) => ({ id: f.id, label: f.label })) }))}
      />
    </>
  );
}
