import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { listSources } from "@/server/jobs/service";
import { JobsNav } from "../JobsNav";
import { SourcesClient } from "./SourcesClient";

export default async function SourcesPage() {
  const user = await requirePageUser();
  return (
    <>
      <PageHeader
        title="Job sources"
        description="Follow companies' public job boards (Greenhouse and Lever publish them through official APIs), or add a single job link. LinkedIn, Naukri and other sites are never read automatically: add those jobs by link and paste the details yourself."
      />
      <JobsNav active="/dashboard/jobs/sources" />
      <SourcesClient sources={await listSources(user)} />
    </>
  );
}
