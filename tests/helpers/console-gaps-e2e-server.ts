/**
 * Child process for apps/console/e2e/gaps-server.e2e.ts (run with tsx: the console server's modules use
 * `import.meta`). Makes a temporary checkout-like root with a real `film:init` film, a job store with a ceiling, one
 * reserved paid job (cancelled locally, no provider) and one queued fal job (fal offers no cancel, so nothing calls a
 * provider), copies the bundle `vite build` just wrote, starts the real console server with the daemon's actions on port
 * 0 and prints one JSON line `{ url, root }`. On SIGTERM, SIGINT or stdin end it closes the server and removes the root.
 * Usage: tsx console-gaps-e2e-server.ts <dist>
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUNDLE_FILES, BUNDLE_VERSION_FILE } from "../../src/lib/console/bundle";
import { consoleActionsWith } from "../../src/lib/console/apply";
import { cardAnswerer } from "../../src/lib/console/cards";
import { controlActions } from "../../src/lib/console/control-actions";
import { notImplementedActions } from "../../src/lib/console/data";
import { startConsoleServer } from "../../src/lib/console/server";
import { deriveWaiting } from "../../src/lib/console/view/waiting";
import { runGenerationStep } from "../../src/lib/jobs/runner";
import { OperationStore } from "../../src/lib/jobs/store";
import { USER_GRANT } from "./ceiling-grant";

const BUNDLE = "gaps-e2e";
const PROJECT = "film";
const REPO = path.resolve(import.meta.dirname, "../..");

for (const name of ["AGENTBROS_EVENTS", "AGENTBROS_HOOKS", "AGENTBROS_CONSOLE"]) process.env[name] = "off";

const sourceDist = process.argv[2];
if (!sourceDist) throw new Error("usage: console-gaps-e2e-server.ts <dist>");

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-gaps-e2e-")));
const init = spawnSync(
  process.execPath,
  [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/film-init.ts"), "--project", PROJECT],
  { cwd: root, encoding: "utf8", env: process.env },
);
if (init.status !== 0) throw new Error(`film:init failed: ${init.stdout}${init.stderr}`);

const bound = {
  currency: "USD" as const,
  lowUsd: 0,
  expectedUsd: 0.5,
  highUsd: 0.5,
  bounded: true as const,
  confidence: "user-bound" as const,
  source: "offline bound",
  asOf: "2026-11-15",
};

async function seedJobs() {
  const store = new OperationStore(PROJECT, { directory: path.join(root, "public/projects", PROJECT, "pipeline") });
  store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  store.reserveOperation({
    operationId: "op-reserved",
    provider: "fal",
    endpoint: "fal-ai/test-model",
    assetId: "asset-reserved",
    inputHash: "a".repeat(64),
    quote: bound,
  });
  await runGenerationStep({
    store,
    operation: {
      operationId: "op-queued",
      provider: "fal",
      endpoint: "fal-ai/test-model",
      assetId: "asset-queued",
      quote: bound,
    },
    input: { prompt: "queued" },
    provider: { submit: async () => ({ requestId: "req-queued" }), inspect: async () => ({ state: "queued" }) },
  });
}

async function main() {
  await seedJobs();
  const dist = path.join(root, "out/console/dist");
  mkdirSync(dist, { recursive: true });
  for (const file of BUNDLE_FILES) copyFileSync(path.join(sourceDist, file), path.join(dist, file));
  writeFileSync(path.join(dist, BUNDLE_VERSION_FILE), `${BUNDLE}\n`);
  const server = await startConsoleServer({
    rootDir: root,
    port: 0,
    bundle: BUNDLE,
    build: false,
    version: "e2e",
    // The daemon's actions (src/lib/console/daemon.ts): real decisions, control, job cancel and hooks install.
    actions: consoleActionsWith(
      root,
      { ...notImplementedActions, answerCard: cardAnswerer(root), ...controlActions(root) },
      { deriveWaiting },
    ),
  });
  process.stdout.write(JSON.stringify({ url: server.url, root }) + "\n");

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      process.exit(0);
    }
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void stop());
  process.stdin.on("end", () => void stop());
  process.stdin.resume();
}

void main();
