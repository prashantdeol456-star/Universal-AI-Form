/**
 * The companion's only network use: HTTPS requests OUT to the user's own server. There is no
 * listening port on this computer. The device token goes only in the Authorization header.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function call<T>(server: string, path: string, opts: { bearer: string; body?: unknown; method?: string; timeoutMs?: number }): Promise<T> {
  const res = await fetch(`${server}${path}`, {
    method: opts.method ?? "POST",
    headers: { authorization: `Bearer ${opts.bearer}`, "content-type": "application/json", accept: "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "error",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON (proxy error page).
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? `Server answered ${res.status}`);
  }
  return data as T;
}

export interface Claim {
  leaseToken: string;
  task: { id: string; type: string; input: Record<string, unknown> };
  step: { id: string; key: string; type: string; input: Record<string, unknown> };
  previous: Record<string, Record<string, unknown> | null>;
  capabilities: string[];
  aiExcerptsAllowed: boolean;
}

export interface HeartbeatReply {
  stop: boolean;
  capabilities: string[];
  aiExcerptsAllowed: boolean;
  revokedFolderIds: string[];
}

export type StepReport = { outcome: "progress" | "completed" | "failed" | "uncertain"; message?: string | null; result?: Record<string, unknown> | null; secret?: string | null };
