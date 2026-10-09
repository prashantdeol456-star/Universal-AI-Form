/**
 * Extension settings and session.
 * - serverUrl: your self-hosted server (e.g. https://forms.example.com).
 * - token: opaque session token from the server. Stored in chrome.storage.session
 *   (memory only, cleared when Chrome closes) unless "Keep me signed in" is chosen.
 */
export const DEFAULT_SERVER_URL = "http://localhost:3000";

export interface Session {
  token: string;
  expiresAt: string;
}

export async function getServerUrl(): Promise<string> {
  const { serverUrl } = await chrome.storage.local.get("serverUrl");
  return typeof serverUrl === "string" && serverUrl ? serverUrl : DEFAULT_SERVER_URL;
}

export async function setServerUrl(url: string): Promise<void> {
  await chrome.storage.local.set({ serverUrl: url.replace(/\/+$/, "") });
  await clearSession();
}

export async function getSession(): Promise<Session | null> {
  const s = (await chrome.storage.session.get("session")).session ?? (await chrome.storage.local.get("session")).session;
  if (!s || typeof s !== "object") return null;
  const session = s as Session;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await clearSession();
    return null;
  }
  return session;
}

export async function saveSession(session: Session, remember: boolean): Promise<void> {
  await clearSession();
  await (remember ? chrome.storage.local : chrome.storage.session).set({ session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove("session");
  await chrome.storage.local.remove("session");
}

/** Host-permission pattern for an origin (match patterns ignore the port). */
export function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
