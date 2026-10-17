import type { NextRequest } from "next/server";
import { requireUser } from "@/server/auth/session";
import { companionEnabled } from "@/server/companion/planner";
import { pairConfirmSchema } from "@/server/companion/schemas";
import { confirmPairing, previewPairing } from "@/server/companion/service";
import { json, parseBody, rateLimit, route } from "@/server/http";

/** The signed-in user enters the code from their computer: first a preview of the device, then confirm. */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  companionEnabled();
  rateLimit("companion-pair-confirm", user.id, 10, 10 * 60_000);
  const { code, confirm } = await parseBody(req, pairConfirmSchema);
  if (!confirm) return json({ preview: await previewPairing(code) }, { headers: { "Cache-Control": "no-store" } });
  return json({ paired: await confirmPairing(user, code) });
});
