import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { getPreferences } from "@/server/jobs/service";
import { JobsNav } from "../JobsNav";
import { PreferencesForm } from "./PreferencesForm";

export default async function PreferencesPage() {
  const user = await requirePageUser();
  return (
    <>
      <PageHeader
        title="Job preferences"
        description="All optional. Leave anything empty and it is simply not used: an unset preference never lowers a job's score. Nothing here is guessed from your documents."
      />
      <JobsNav active="/dashboard/jobs/preferences" />
      <PreferencesForm initial={await getPreferences(user)} />
    </>
  );
}
