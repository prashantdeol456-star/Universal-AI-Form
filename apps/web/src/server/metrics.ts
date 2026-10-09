import "server-only";

/**
 * In-process request metrics (phase 13), exposed in Prometheus text format at
 * /api/metrics. Paths are normalised (ids → :id) so cardinality stays small, and
 * nothing user-specific is recorded.
 */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

const g = globalThis as unknown as { __ufaMetrics?: { requests: Map<string, number>; latency: Map<string, Series>; startedAt: number } };
const state = () => (g.__ufaMetrics ??= { requests: new Map(), latency: new Map(), startedAt: Date.now() });

export function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .slice(0, 120);
}

export function recordRequest(method: string, path: string, status: number, seconds: number) {
  const s = state();
  const route = normalizePath(path);
  const key = `${method}|${route}|${Math.floor(status / 100)}xx`;
  s.requests.set(key, (s.requests.get(key) ?? 0) + 1);
  const lk = `${method}|${route}`;
  let l = s.latency.get(lk);
  if (!l) s.latency.set(lk, (l = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }));
  l.count++;
  l.sum += seconds;
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) l.buckets[i]!++;
  });
}

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Prometheus exposition text; `gauges` are point-in-time values computed by the caller. */
export function renderMetrics(gauges: Record<string, { help: string; value: number }>): string {
  const s = state();
  const out: string[] = [];
  out.push("# HELP ufa_http_requests_total API requests by route and status class", "# TYPE ufa_http_requests_total counter");
  for (const [k, n] of s.requests) {
    const [method, route, status] = k.split("|");
    out.push(`ufa_http_requests_total{method="${method}",route="${esc(route!)}",status="${status}"} ${n}`);
  }
  out.push("# HELP ufa_http_request_duration_seconds API latency", "# TYPE ufa_http_request_duration_seconds histogram");
  for (const [k, l] of s.latency) {
    const [method, route] = k.split("|");
    const labels = `method="${method}",route="${esc(route!)}"`;
    BUCKETS.forEach((b, i) => out.push(`ufa_http_request_duration_seconds_bucket{${labels},le="${b}"} ${l.buckets[i]}`));
    out.push(`ufa_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${l.count}`);
    out.push(`ufa_http_request_duration_seconds_sum{${labels}} ${l.sum.toFixed(4)}`, `ufa_http_request_duration_seconds_count{${labels}} ${l.count}`);
  }
  out.push("# HELP ufa_process_uptime_seconds Process uptime", "# TYPE ufa_process_uptime_seconds gauge", `ufa_process_uptime_seconds ${Math.round((Date.now() - s.startedAt) / 1000)}`);
  const mem = process.memoryUsage();
  out.push("# HELP ufa_process_resident_memory_bytes Resident memory", "# TYPE ufa_process_resident_memory_bytes gauge", `ufa_process_resident_memory_bytes ${mem.rss}`);
  for (const [name, gauge] of Object.entries(gauges)) {
    out.push(`# HELP ${name} ${gauge.help}`, `# TYPE ${name} gauge`, `${name} ${gauge.value}`);
  }
  return `${out.join("\n")}\n`;
}
