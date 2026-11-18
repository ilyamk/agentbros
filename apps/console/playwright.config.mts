/**
 * Studio console end-to-end and accessibility tests (`pnpm console:e2e`, RFC 0004 §13). They run only with
 * RUN_CONSOLE_E2E=1 (not in `pnpm check`); evidence goes to out/qa/console/ (git-ignored). Needs Playwright's
 * Chromium: `pnpm exec playwright install chromium`.
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repo = path.resolve(import.meta.dirname, "../..");
const enabled = process.env.RUN_CONSOLE_E2E === "1";
const port = Number(process.env.CONSOLE_E2E_PORT ?? 4318);

export default defineConfig({
  testDir: path.join(import.meta.dirname, "e2e"),
  testMatch: "**/*.e2e.ts",
  outputDir: path.join(repo, "out/qa/console/results"),
  reporter: [["list"]],
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}/`, ...devices["Desktop Chrome"] },
  webServer: enabled
    ? {
        command: `pnpm exec vite build --config apps/console/vite.config.mts && pnpm exec vite preview --config apps/console/vite.config.mts --port ${port} --strictPort`,
        cwd: repo,
        url: `http://127.0.0.1:${port}/`,
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
});
