import { IconChat } from "@/components/icons";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { timeAgo } from "@/lib/labels";
import { listSavedAnswers } from "@/server/agent/service";
import { requirePageUser } from "@/server/auth/session";
import { asUser } from "@/server/db";
import { AiSharingToggle, AnswerRow } from "./AnswersClient";

export default async function SavedAnswersPage() {
  const user = await requirePageUser("profile:read_own");
  const [answers, [pref]] = await Promise.all([
    listSavedAnswers(user),
    asUser(user, (tx) => tx<{ ai_profile_sharing: boolean }[]>`select ai_profile_sharing from profiles where user_id = ${user.id}`),
  ]);

  return (
    <>
      <PageHeader
        title="Saved answers"
        description="Answers you gave the assistant to form questions that are not part of your profile (“How did you hear about us?”, “Tell us about yourself”). They are filled again when the same question appears. Edit or delete them any time."
      />
      <Card title="AI writing answers for you">
        <AiSharingToggle enabled={pref?.ai_profile_sharing ?? false} />
      </Card>
      <Card title={`${answers.length} saved answer${answers.length === 1 ? "" : "s"}`}>
        {answers.length === 0 ? (
          <EmptyState icon={<IconChat size={22} />} title="Nothing saved yet">
            Press “Fill everything” in the extension; questions it asks you are remembered here.
          </EmptyState>
        ) : (
          <ul className="-my-2 divide-y divide-gray-100">
            {answers.map((a) => (
              <AnswerRow key={a.id} id={a.id} question={a.question} answer={a.answer} meta={`${a.domain ?? "any site"} · updated ${timeAgo(a.updatedAt)}`} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
