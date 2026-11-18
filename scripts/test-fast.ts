/**
 * Quick unit tests: `pnpm test` minus browser, workflow, real-media and slow suites.
 * New test files run here by default. A file joins SLOW only after measurement:
 * each file was timed alone (2026-11-11, 8 in parallel on 10 cores); SLOW holds the
 * ones that took over 15 s, plus suites whose child-process deadlines fail under parallel load.
 * portable-craft-skills is split (2026-11-13): its CLI half, portable-craft-skills-cli, took 30 s alone and stays in SLOW.
 * `pnpm test` and the `test:*` aliases still cover everything excluded here.
 *
 * Usage: pnpm test:fast [--list] [extra node:test flags]
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";

const EXCLUDED_PATTERNS = [/browser/, /^workflow-/, /-actual/];

// Workflow subprocess fixtures measured 35–65 s locally; CI runs their CLI contracts separately.
const SLOW = new Set(
  [
    "agent-workflow",
    "agent-workflow-agent",
    "agent-workflow-cli",
    "assets-import",
    "audio-editorial",
    "audio-map",
    "audio-master-project",
    "audio-position-trim",
    "backend-handoff",
    "blender-run",
    "chapter-fonts",
    "chart-domain-probe",
    "chart-quantity-routes",
    "cleanup",
    "cli",
    "corpus-diagnostics",
    "craft-evaluation",
    "delivery-resource-use-context",
    "delivery",
    "edit-cli",
    "fal-legacy-boundary",
    "film-chain",
    "film-sensors",
    "harness-runtime",
    "http-stream",
    "ingest",
    "lint",
    "local-category",
    "local-engines",
    "local-ingest",
    "local-ocr",
    "local-visual",
    "longform-scale",
    "longform-worker",
    "longform",
    "mcp",
    "model-discovery-routing",
    "motion-check",
    "motion-vision",
    "music",
    "native-font-recovery",
    "native-word-timing",
    "paid-boundary",
    "platform-audio-handoff-cli",
    "portable-craft-skills-cli",
    "qa-evidence",
    "realtime-channel",
    "realtime-derive",
    "realtime-editor",
    "realtime-session",
    "realtime-still-draft",
    "reference-decomposition",
    "reference-degrade",
    "reference-derive",
    "reference-derive-blender",
    "reference-derive-fal",
    "reference-derive-matte",
    "reference-e2e",
    "reference-sensors",
    "rejected-observation",
    "render-plan",
    "resolve-worker",
    "resource-response-bounds",
    "resource-routes",
    "review-audio-duration",
    "review-audio-mix",
    "review-audio-pcm",
    "review-audio-position-render",
    "review-authored-copy",
    "review-chapters-consistency",
    "review-chapters",
    "review-realtime-channel",
    "review-visual-remove",
    "rhythm-artifact-publication",
    "rhythm-preparation",
    "seedance-budget-forecast",
    "semantic-broll",
    "sphere-contacts",
    "tariff-coverage-cli",
    "voice-tariff-routing",
    "word-canonical-race",
    "entity-cards",
    "native-composition-instances-integration",
    "native-composition-instances-profile-routing",
    "platform-audio-packet",
    "provider-references",
    "review-authored-copy-stills",
    "review-format-reframe",
    "review-format-reframe-render",
    "review-visual-slip",
    "sfx-library",
    "templates-recipes",
    // Deadline-sensitive under parallel load:
    "bench",
    "harness-read-snapshot",
    "review-realtime",
    "review-realtime-channel-extensions",
    "review-realtime-channel-transport",
    "rhythm-private-staging",
    "review-visual-split-original",
  ].map((name) => `${name}.test.ts`),
);

// Help answers before reading the tests directory, so it works from any cwd (CLI JSON contract).
if (process.argv.slice(2).includes("--help")) {
  process.stderr.write("Usage: pnpm test:fast [--list] [extra node:test flags]\n");
  process.stdout.write(`${JSON.stringify({ ok: true, outputs: [], metadata: { help: true }, elapsedMs: 0 })}\n`);
  process.exit(0);
}

const files = readdirSync("tests")
  .filter(
    (file) => file.endsWith(".test.ts") && !SLOW.has(file) && !EXCLUDED_PATTERNS.some((pattern) => pattern.test(file)),
  )
  .sort()
  .map((file) => `tests/${file}`);

const args = process.argv.slice(2);
if (args.includes("--list")) {
  process.stdout.write(`${files.join("\n")}\n`);
  process.exit(0);
}

const concurrency = process.env["TEST_CONCURRENCY"] ?? String(Math.max(1, availableParallelism() - 1));
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
process.stderr.write(`[test:fast] ${files.length} files, concurrency ${concurrency}\n`);
const memoryRoot = new URL("../tests/helpers/memory-root.ts", import.meta.url).href;
const result = spawnSync(
  process.execPath,
  [tsx, "--test", "--import", memoryRoot, `--test-concurrency=${concurrency}`, ...args, ...files],
  { stdio: "inherit", shell: false },
);
process.exit(result.status ?? 1);
