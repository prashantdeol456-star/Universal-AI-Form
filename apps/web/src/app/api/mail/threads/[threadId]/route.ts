import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { json, rateLimit, route } from "@/server/http";
import { readThread } from "@/server/messaging/gmail";
import { gmailThreadId } from "@/server/messaging/schemas";
import { needsReply, replyRecipients } from "@ufa/messaging";

type Ctx = { params: Promise<{ threadId: string }> };

/** One thread, bounded (latest 20 messages, 8 000 characters each, quoted history removed). Never cached. */
export const GET = route<Ctx>(async (_req: NextRequest, { params }) => {
  const user = await requireUser();
  rateLimit("mail-read", user.id, 60, 60_000);
  const threadId = gmailThreadId.parse((await params).threadId);
  const { thread, account } = await readThread(user, threadId);
  const r = replyRecipients(thread, account);
  return json(
    {
      id: thread.id,
      subject: thread.subject,
      omitted: thread.omitted,
      needsReply: needsReply(thread, account),
      replyTo: r.to,
      messages: thread.messages.map((m, i) => ({ ref: `M${i + 1}`, ...m, fromMe: m.from?.email === account })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
