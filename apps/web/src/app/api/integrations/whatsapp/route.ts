import { requireUser } from "@/server/auth/session";
import { json, route } from "@/server/http";
import { whatsappCapabilities } from "@/server/messaging/whatsapp";

/** What WhatsApp access exists: chat-export import (always), Business Platform (detected only), sending (never). */
export const GET = route(async () => {
  const user = await requireUser();
  void user;
  return json(whatsappCapabilities());
});
