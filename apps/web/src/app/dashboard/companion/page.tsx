import Link from "next/link";
import { CAPABILITIES, COMMAND_TEMPLATES } from "@ufa/local-agent";
import { TASK_STATUS_LABELS, TASK_TYPES, type TaskStatus } from "@ufa/shared/tasks";
import { Badge, Card, PageHeader } from "@/components/ui";
import { timeAgo } from "@/lib/labels";
import { modelRouter } from "@/server/ai/router";
import { requirePageUser } from "@/server/auth/session";
import { listDevices } from "@/server/companion/service";
import { asUser } from "@/server/db";
import { env } from "@/server/env";
import { TASK_TONE } from "../tasks/meta";
import { CompanionClient } from "./CompanionClient";

export default async function CompanionPage() {
  const user = await requirePageUser();
  if (!env().COMPANION_ENABLED) {
    return (
      <>
        <PageHeader title="Your computer (local companion)" description="Approved file actions and project commands on your own computer." />
        <Card>
          <p className="text-sm text-gray-700">The local companion is switched off on this server. The administrator can turn it on with COMPANION_ENABLED=true (see docs/companion.md).</p>
        </Card>
      </>
    );
  }
  const [devices, recent] = await Promise.all([
    listDevices(user),
    asUser(user, (tx) => tx<{ id: string; title: string; task_type: string; status: TaskStatus; created_at: Date }[]>`
      select id, title, task_type, status, created_at from tasks where task_type like 'local\\_%' order by created_at desc limit 10`),
  ]);
  const router = modelRouter();
  const ai = { local: router.local("plan_task") !== null, cloud: router.cloudAvailable("plan_task") };
  return (
    <>
      <PageHeader
        title="Your computer (local companion)"
        description="A small program on your computer does approved work for you: summarise files, organise a folder, write a file report, run project commands like tests. It connects out to this server; nothing can reach into your computer. Every change needs your approval here."
      />
      <CompanionClient
        devices={devices}
        capabilities={Object.entries(CAPABILITIES).map(([id, c]) => ({ id, label: c.label, implemented: c.implemented, sideEffects: c.sideEffects }))}
        commands={COMMAND_TEMPLATES.map((c) => ({ id: c.id, label: c.label, effects: c.effects }))}
        ai={ai}
      />
      <Card title="Recent computer tasks">
        {recent.length === 0 ? (
          <p className="text-sm text-gray-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {recent.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <Link href={`/dashboard/tasks/${t.id}`} className="min-w-0 truncate text-brand-700 hover:underline">
                  {t.title}
                </Link>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="hidden text-xs text-gray-500 sm:inline">{TASK_TYPES[t.task_type as keyof typeof TASK_TYPES]?.label}</span>
                  <Badge tone={TASK_TONE[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
                  <span className="text-xs text-gray-400">{timeAgo(t.created_at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
