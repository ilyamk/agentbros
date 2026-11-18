/** Studio console unit tests: Vitest with jsdom over apps/console only (`pnpm console:test`). */
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.mts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      root: import.meta.dirname,
      environment: "jsdom",
      include: ["**/*.test.{ts,tsx}"],
      exclude: ["**/node_modules/**", "e2e/**"],
      restoreMocks: true,
      setupFiles: ["./test/setup.ts"],
    },
  }),
);
