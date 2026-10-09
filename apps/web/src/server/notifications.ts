import "server-only";
import { asUser, db, type Actor } from "./db";

/**
 * In-app notifications (phase 13): café requests, forms filled at a café,
 * documents read, sign-ins from a new device, account deletion. Written by the
 * server (system pool); each user reads and marks only their own (RLS).
 * Texts never contain profile values.
 */
export async function notify(userId: string, n: { type: string; title: string; body?: string | null; link?: string | null }) {
  await db().system`
    insert into notifications (user_id, type, title, body, link)
    values (${userId}, ${n.type}, ${n.title.slice(0, 200)}, ${n.body?.slice(0, 500) ?? null}, ${n.link ?? null})`;
}

/** "Chrome on Windows" from a user-agent string (rough, for humans). */
export function describeDevice(ua: string | null): string {
  if (!ua) return "an unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "an unknown system";
  return `${browser} on ${os}`;
}

/** Tells the user when their account is used from a browser/device it has not seen in 180 days. */
export async function notifyNewDevice(userId: string, userAgent: string | null) {
  const [seen] = await db().system<{ known: boolean; any: boolean }[]>`
    select exists (select 1 from auth_sessions where user_id = ${userId} and user_agent = ${userAgent?.slice(0, 300) ?? null}
                    and created_at > now() - interval '180 days') as known,
           exists (select 1 from auth_sessions where user_id = ${userId}) as any`;
  if (!seen || seen.known || !seen.any) return; // first ever sign-in is not "new"
  await notify(userId, {
    type: "security_new_device",
    title: `New sign-in from ${describeDevice(userAgent)}`,
    body: "If this was not you, change your password and sign out other devices in Settings.",
    link: "/dashboard/settings#sessions",
  });
}

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export async function listNotifications(actor: Actor, limit = 50): Promise<{ items: NotificationView[]; unread: number }> {
  return asUser(actor, async (tx) => {
    const rows = await tx<{ id: string; type: string; title: string; body: string | null; link: string | null; read_at: Date | null; created_at: Date }[]>`
      select id, type, title, body, link, read_at, created_at from notifications where user_id = ${actor.id} order by created_at desc limit ${limit}`;
    const [u] = await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${actor.id} and read_at is null`;
    return {
      unread: u!.n,
      items: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, read: r.read_at !== null, createdAt: r.created_at.toISOString() })),
    };
  });
}

export async function unreadCount(actor: Actor): Promise<number> {
  const [u] = await asUser(actor, (tx) => tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${actor.id} and read_at is null`);
  return u?.n ?? 0;
}

export async function markRead(actor: Actor, ids: string[] | "all") {
  await asUser(actor, (tx) =>
    ids === "all"
      ? tx`update notifications set read_at = now() where user_id = ${actor.id} and read_at is null`
      : tx`update notifications set read_at = now() where user_id = ${actor.id} and id in ${tx(ids)} and read_at is null`,
  );
  return { ok: true as const };
}
