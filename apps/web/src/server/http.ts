import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { taskErrorInfo } from "@ufa/tasks";
import { createRateLimiter, redact, type RateLimiter } from "@ufa/security";
import { env } from "./env";
import { recordRequest } from "./metrics";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, "bad_request", msg, details);
export const unauthorized = (msg = "Sign in required") => new HttpError(401, "unauthorized", msg);
export const forbidden = (msg = "You do not have access to this resource") => new HttpError(403, "forbidden", msg);
export const notFound = (msg = "Not found") => new HttpError(404, "not_found", msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, "conflict", msg, details);
export const tooMany = (retryAfter: number) =>
  new HttpError(429, "rate_limited", `Too many attempts. Try again in ${retryAfter} seconds.`, { retryAfter });

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  return schema.parse(raw);
}

export function clientIp(req: NextRequest): string {
  if (env().TRUST_PROXY) {
    // Caddy sets X-Forwarded-For; the left-most entry is the original client.
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real;
  }
  return "unknown";
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: the Origin
 * (or Referer) must match APP_URL. Bearer-token requests (extension) are exempt
 * because browsers never attach them automatically.
 */
export function assertSameOrigin(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  if (req.headers.get("authorization")?.startsWith("Bearer ")) return;
  const expected = new URL(env().APP_URL).origin;
  const origin = req.headers.get("origin") ?? (req.headers.get("referer") ? new URL(req.headers.get("referer")!).origin : null);
  // The browser extension (e.g. its sign-in call) sends no cookies, so there is nothing to forge.
  // Web pages cannot fake a chrome-extension:// Origin header.
  if (origin?.startsWith("chrome-extension://") && !req.cookies.get("ufa_session")) return;
  if (origin !== expected) throw forbidden("Cross-site request blocked");
}

const limiters = new Map<string, RateLimiter>();
export function rateLimit(bucket: string, key: string, limit: number, windowMs: number) {
  let l = limiters.get(bucket);
  if (!l) {
    l = createRateLimiter({ limit, windowMs });
    limiters.set(bucket, l);
  }
  const r = l.consume(key);
  if (!r.allowed) throw tooMany(r.retryAfterSeconds);
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Wraps a route handler with CSRF checks and uniform, log-safe error handling. */
export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const started = performance.now();
    const res = await handle(handler, req, ctx);
    recordRequest(req.method, req.nextUrl.pathname, res.status, (performance.now() - started) / 1000);
    return res;
  };
}

async function handle<C>(handler: Handler<C>, req: NextRequest, ctx: C): Promise<Response> {
  try {
    assertSameOrigin(req);
    return await handler(req, ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      const res = json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
      if (err.status === 429) {
        res.headers.set("Retry-After", String((err.details as { retryAfter: number }).retryAfter));
      }
      return res;
    }
    // Task engine errors carry their own HTTP status (404 not found, 409 invalid transition / lease lost / …).
    const taskErr = taskErrorInfo(err);
    if (taskErr) return json({ error: { code: taskErr.code, message: taskErr.message } }, { status: taskErr.status });
    if (err instanceof ZodError) {
      return json(
        {
          error: {
            code: "validation_error",
            message: err.issues[0]?.message ?? "Invalid input",
            details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        },
        { status: 422 },
      );
    }
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[api] ${req.method} ${req.nextUrl.pathname} failed: ${redact(msg)}`);
    return json({ error: { code: "internal_error", message: "Something went wrong" } }, { status: 500 });
  }
}
