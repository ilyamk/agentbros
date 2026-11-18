import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectMetrics, metricDeltas, withReadmeMetrics, writeReadmeMetrics } from "../src/lib/metrics";
import { COMMAND_REGISTRY } from "../src/lib/cli/commands";

const root = process.cwd();
const metrics = collectMetrics(root);

test("real tree inventories are consistent and unknown evidence stays explicit", () => {
  assert.ok(metrics.raw.playbooks.total >= 17);
  assert.ok(metrics.raw.blocks.total >= 100);
  assert.equal(metrics.raw.commands.total, COMMAND_REGISTRY.length);
  assert.equal(
    Object.values(metrics.raw.commands.bySpend).reduce((sum, value) => sum + value, 0),
    metrics.raw.commands.total,
  );
  assert.equal(
    Object.values(metrics.raw.blocks.byCategory).reduce((sum, value) => sum + value, 0),
    metrics.raw.blocks.total,
  );
  for (const [kind, rows] of Object.entries(metrics.evidence)) {
    assert.equal(metrics.verified[kind as keyof typeof metrics.verified], rows.filter((row) => row.verified).length);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, kind);
    rows.forEach((row) => assert.equal(row.verified, row.missing.length === 0));
  }
  assert.ok(metrics.evidence.sensors.some((sensor) => sensor.id === "film:measure:motion-spread" && sensor.verified));
  assert.ok(metrics.evidence.sensors.some((sensor) => sensor.id === "plan:check:text-hold-long" && !sensor.verified));
  assert.ok(metrics.health.unknown.length > 0);
  assert.ok(metrics.raw.tests >= 300);
});

test("README marker round-trip changes only the marked table on a temporary copy", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "metrics-readme-"));
  try {
    const original = readFileSync(path.join(root, "README.md"), "utf8");
    writeFileSync(path.join(directory, "README.md"), original);
    writeReadmeMetrics(directory, metrics);
    const written = readFileSync(path.join(directory, "README.md"), "utf8");
    const strip = (text: string) => text.replace(/<!-- metrics:start -->[\s\S]*?<!-- metrics:end -->/, "MARKED");
    assert.equal(strip(written), strip(original));
    assert.match(written, new RegExp(`<h2>${metrics.raw.playbooks.total}</h2><sub>genres`));
    assert.match(
      written,
      new RegExp(
        `<h2>${metrics.raw.blocks.total}</h2><sub>motion-design<br>blocks \\(${metrics.verified.blocks} verified`,
      ),
    );
    assert.equal(withReadmeMetrics(written, metrics), written);
    assert.equal((written.match(/width="20%"/g) ?? []).length, 5);
    for (const invalid of [
      "",
      "<!-- metrics:start -->",
      "<!-- metrics:end --><!-- metrics:start -->",
      "<!-- metrics:start --><!-- metrics:start --><!-- metrics:end -->",
    ])
      assert.throws(() => withReadmeMetrics(invalid, metrics), /marker pair/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixture evidence distinguishes preview, test, use, benchmarks and calibration", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "metrics-fixture-"));
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), text);
  };
  try {
    put("tsconfig.json", '{"compilerOptions":{"target":"ES2022"},"include":["**/*.ts"]}');
    put(
      "docs/library/catalogue.json",
      JSON.stringify({
        items: [
          { id: "covered", category: "type", preview: { image: "covered.jpg" } },
          { id: "unused", category: "type", preview: { image: "unused.jpg" } },
          { id: "no-preview", category: "type" },
        ],
      }),
    );
    put(
      "playbooks/example/playbook.json",
      JSON.stringify({
        id: "example",
        status: "ready",
        benchmarks: ["example-bench"],
        commands: ["film:init"],
        library: { blocks: ["covered", "no-preview"] },
      }),
    );
    put("tests/library.test.ts", "test('covered and unused and no-preview', () => assert.ok(true));");
    put("tests/command.test.ts", "test('scripts/film-init.ts contract', () => assert.ok(true));");
    put("src/lib/models/endpoints.json", '{"model":["endpoint"]}');
    put("src/lib/providers/schemas/fal-operations.json", '[{"endpoint":"endpoint"}]');
    put("src/lib/providers/fal-music.ts", 'const model = { endpoint: "music" };');
    put("src/lib/film/plan-check.ts", 'function plan(){ const dimension = "provisional"; return { dimension }; }');
    put(
      "src/lib/film/measure.ts",
      '// calibrated on fixture\nconst LIMIT = 1;\nfunction leg(){const id = "calibrated";return {id, value: LIMIT};}\n// provisional\nconst OTHER = 1;\nfunction next(){const id = "uncalibrated";return {id, value:OTHER};}',
    );
    put("src/lib/film/cut-sound.ts", "export {};");
    put("src/lib/sensors/findings.ts", 'const COUNTER_OF_CODE = { A: "shared", B: "shared" } as const;');
    put(
      "tests/agents-md.test.ts",
      "const KIB = 1024; const AREA_TARGET_BYTES = 12 * KIB; const SHRINKING = {'area/AGENTS.md': {limit: 20*KIB,target:AREA_TARGET_BYTES}};",
    );
    put("area/AGENTS.md", "x".repeat(13 * 1024));
    const result = collectMetrics(directory);
    assert.equal(result.verified.blocks, 1);
    assert.equal(result.verified.playbooks, 1);
    assert.equal(result.raw.sensors, 4);
    assert.equal(result.verified.sensors, 1);
    assert.equal(result.raw.endpoints, 2);
    assert.equal(result.raw.referenceFilms, null);
    assert.deepEqual(result.health.instructionFilesOverTarget, [
      { file: "area/AGENTS.md", bytes: 13312, target: 12288 },
    ]);
    put("usage.json", '{"blocks":[{"id":"unused"}]}');
    assert.equal(collectMetrics(directory, [path.join(directory, "usage.json")]).verified.blocks, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("metric deltas cover additions, removals and changes without fabricating unknown counts", () => {
  assert.deepEqual(
    metricDeltas(
      { version: 1, raw: { blocks: 3, removed: 1, referenceFilms: null } },
      { version: 1, raw: { blocks: 4, added: 2, referenceFilms: 3 } },
    ),
    { "raw.added": 2, "raw.blocks": 1, "raw.removed": -1 },
  );
});

test("metrics.ts CLI emits one JSON line, and diffs a supplied snapshot", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "metrics-cli-"));
  try {
    const old = path.join(directory, "metrics.json");
    writeFileSync(old, JSON.stringify({ raw: { agents: 0 } }));
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/metrics.ts", "--diff", old], {
      cwd: root,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, AGENTBROS_MEMORY_ROOT: directory },
      timeout: 120000,
    });
    assert.equal(child.status, 0, child.stderr);
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]!);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.deltas["raw.agents"], metrics.raw.agents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
