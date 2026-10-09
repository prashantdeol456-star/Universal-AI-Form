"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Alert, Badge, Button } from "./ui";

interface SessionView {
  id: string;
  clientType: string;
  userAgent: string | null;
  ipAddress: string | null;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

function describeAgent(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

export function SessionsList() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ sessions: SessionView[] }>("/api/account/sessions");
    if (res.ok) setSessions(res.data.sessions);
    else setError(res.error.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    const res = await api(`/api/account/sessions/${id}`, { method: "DELETE" });
    if (!res.ok) return setError(res.error.message);
    await load();
  }

  if (error) return <Alert>{error}</Alert>;
  if (!sessions) return <p className="text-sm text-gray-500">Loading…</p>;
  return (
    <ul className="divide-y divide-gray-100">
      {sessions.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
          <div>
            <div className="font-medium text-gray-900">
              {describeAgent(s.userAgent)} {s.clientType === "extension" && <Badge tone="blue">Extension</Badge>}{" "}
              {s.current && <Badge tone="green">This device</Badge>}
            </div>
            <div className="text-xs text-gray-500">
              Last active {new Date(s.lastSeenAt).toLocaleString("en-IN")} · IP {s.ipAddress ?? "unknown"} · expires{" "}
              {new Date(s.expiresAt).toLocaleDateString("en-IN")}
            </div>
          </div>
          {!s.current && (
            <Button size="sm" variant="danger" onClick={() => revoke(s.id)}>
              Sign out
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
