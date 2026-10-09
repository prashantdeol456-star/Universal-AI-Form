/** Browser-side JSON client for the app's own REST API (same-origin, cookie auth). */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, status: 0, error: { code: "network_error", message: "Network error. Check your connection." } };
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const error: ApiError = payload?.error ?? { code: "http_error", message: `Request failed (${res.status})` };
    return { ok: false, status: res.status, error };
  }
  return { ok: true, data: payload as T };
}
