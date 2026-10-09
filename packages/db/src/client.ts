import postgres from "postgres";

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

export interface DbConfig {
  /** Owner/system connection (bypasses RLS). Server-side trusted code only. */
  systemUrl: string;
  /** Runtime connection as the restricted `ufa_app` role (RLS enforced). */
  appUrl: string;
  maxConnections?: number;
}

export interface Db {
  system: Sql;
  app: Sql;
  close(): Promise<void>;
}

export function createDb(cfg: DbConfig): Db {
  const common = {
    max: cfg.maxConnections ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // Keep Postgres NOTICEs out of application logs.
    onnotice: () => {},
    transform: { undefined: null },
  } satisfies postgres.Options<Record<string, postgres.PostgresType>>;

  const system = postgres(cfg.systemUrl, { ...common, max: Math.max(2, Math.floor((cfg.maxConnections ?? 10) / 2)) });
  const app = postgres(cfg.appUrl, common);
  return {
    system,
    app,
    async close() {
      await Promise.all([system.end({ timeout: 5 }), app.end({ timeout: 5 })]);
    },
  };
}

export interface UserContext {
  userId: string;
  role: string;
}

/**
 * Runs `fn` inside a transaction on the RLS-enforced pool with the user's
 * identity bound via transaction-local settings. Every user-scoped query in the
 * app must go through this function.
 */
export async function withUser<T>(db: Db, ctx: UserContext, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.user_role', ${ctx.role}, true)`;
    return fn(tx);
  });
  return result as T;
}
