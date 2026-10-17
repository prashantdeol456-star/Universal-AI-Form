import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { listFeedback } from "@/server/jobs/feedback";
import { JobsNav } from "../JobsNav";
import { FeedbackManager } from "./FeedbackManager";

export default async function FeedbackPage() {
  const user = await requirePageUser();
  const data = await listFeedback(user);
  return (
    <>
      <PageHeader
        title="Your feedback & rules"
        description="Everything you told the job ranking. Votes are kept for your review only. Corrections change the score of one job. Ranking rules re-order jobs but never change a fit score. Nothing here changes your profile or trains a model; delete anything at any time."
      />
      <JobsNav active="/dashboard/jobs/feedback" />
      <FeedbackManager initial={data} />
    </>
  );
}
