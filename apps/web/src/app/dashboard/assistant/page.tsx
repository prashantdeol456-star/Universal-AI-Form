import { requirePageUser } from "@/server/auth/session";
import { getSession, listSessions } from "@/server/chat/service";
import type { ChatSessionDetail } from "@/server/chat/types";
import { ChatAssistant } from "./ChatAssistant";

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const user = await requirePageUser("chat:use");
  const sessions = await listSessions(user);
  const { s } = await searchParams;
  // ?s=new starts an empty conversation; no parameter reopens the most recent one.
  const wanted = s === "new" ? undefined : s && /^[0-9a-f-]{36}$/i.test(s) ? s : sessions[0]?.id;
  let current: ChatSessionDetail | null = null;
  if (wanted && sessions.some((x) => x.id === wanted)) current = await getSession(user, wanted);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">AI Assistant</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          Tell me about yourself in English, हिंदी or Hinglish. I’ll suggest what to save to your profile — nothing is saved until
          you click Save. Ask me anything you’ve saved, like “What is my date of birth?”.
        </p>
      </div>
      <ChatAssistant key={current?.id ?? "new"} sessions={sessions} initial={current} />
    </>
  );
}
