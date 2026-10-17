import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { listMissions } from "@/server/companion/missions";
import { env } from "@/server/env";
import { MISSION_TONE, MISSION_LABEL } from "./meta";

export default async function MissionsPage() {
  const user = await requirePageUser();
  if (!env().COMPANION_ENABLED) {
    return (
      <>
        <PageHeader title="Missions" />
        <Card>
          <p className="text-sm text-gray-700">Missions use the local companion, which is switched off on this server.</p>
        </Card>
      </>
    );
  }
  const missions = await listMissions(user);
  return (
    <>
      <PageHeader title="Missions" description="Multi-step jobs across your computers: the Planner agent splits them, File and Command agents do each step (with your approvals), the Reviewer agent sums up." />
      <Card>
        {missions.length === 0 ? (
          <p className="text-sm text-gray-500">
            No missions yet. Plan one on the{" "}
            <Link href="/dashboard/companion" className="text-brand-700 hover:underline">
              Computer
            </Link>{" "}
            page.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {missions.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/dashboard/missions/${m.id}`} className="min-w-0 truncate text-brand-700 hover:underline">
                  {m.title}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">
                    {m.done}/{m.parts} steps
                  </span>
                  <Badge tone={MISSION_TONE[m.status]}>{MISSION_LABEL[m.status]}</Badge>
                  <span className="text-xs text-gray-400">{timeAgo(m.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
