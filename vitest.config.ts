import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB integration tests share one database; run files sequentially.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/web/src/**/*.test.ts", "apps/extension/src/**/*.test.ts", "apps/companion/src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // Integration tests against a real PostgreSQL (RLS, migrations).
        // Skipped automatically when TEST_DATABASE_URL is not set.
        test: {
          name: "db",
          include: ["database/tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
