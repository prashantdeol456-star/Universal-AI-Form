import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/session";
import { HttpError } from "@/server/http";
import { getJob } from "@/server/jobs/service";
import { JobDetailView } from "./JobDetailView";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  try {
    return <JobDetailView job={await getJob(user, id)} today={new Date().toISOString().slice(0, 10)} />;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
}
