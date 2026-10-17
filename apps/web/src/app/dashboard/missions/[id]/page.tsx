import { notFound } from "next/navigation";
import Link from "next/link";
import { HttpError } from "@/server/http";
import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { getMission } from "@/server/companion/missions";
import { env } from "@/server/env";
import { MissionView } from "./MissionView";

export default async function MissionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!env().COMPANION_ENABLED || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  let mission;
  try {
    mission = await getMission(user, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/dashboard/missions" className="hover:underline">
            Missions
          </Link>
        }
        title={mission.title}
      />
      <MissionView initial={mission} />
    </>
  );
}
