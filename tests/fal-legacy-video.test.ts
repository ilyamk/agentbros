import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import type { FalCatalogEntry } from "../src/types/fal-catalog";

const repo = path.resolve(import.meta.dirname, "..");
const endpoint = "fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
const replacement = "fal-ai/kling-video/v3/pro/text-to-video";

for (const scenario of [
  { name: "retiring", patch: { retiresAt: "2026-12-31", replacement }, warning: /retires at 2026-12-31/ },
  { name: "gone", patch: { status: "gone", replacement }, warning: /is gone from the catalogue/ },
  { name: "gone without replacement", patch: { status: "gone" }, warning: /No replacement is recorded/ },
  { name: "active", patch: {}, warning: null },
  { name: "unindexed", patch: null, warning: null },
] satisfies { name: string; patch: Partial<FalCatalogEntry> | null; warning: RegExp | null }[]) {
  test(`legacy video dry-run preserves its payload and reports ${scenario.name} catalogue status`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "fal-legacy-video-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const catalog = useTempFalCatalog(
      scenario.patch
        ? [{ endpoint: "fal-ai/aura-sr", cached: false, patch: { ...scenario.patch, endpoint, schema: null } }]
        : [],
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repo, "node_modules/tsx/dist/loader.mjs"),
        "--import",
        path.join(repo, "tests/helpers/fal-no-network.ts"),
        path.join(repo, "scripts/generate-video.ts"),
        "--prompt",
        "Offline coast",
        "--output",
        "clip.mp4",
        "--dry-run",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
          AGENTBROS_FAL_CATALOG_DIR: catalog.catalogDir,
          AGENTBROS_FAL_SCHEMA_CACHE: catalog.cacheDir,
        },
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]!);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.dryRun, true);
    assert.equal(result.metadata.endpoint, endpoint);
    assert.deepEqual(result.metadata.input, {
      prompt: "Offline coast",
      duration: "5",
      aspect_ratio: "16:9",
      cfg_scale: 0.5,
    });
    assert.deepEqual(result.outputs, []);
    assert.deepEqual(readdirSync(root), []);
    if (scenario.warning) {
      assert.equal(result.metadata.warnings.length, 1);
      assert.match(result.metadata.warnings[0], scenario.warning);
      assert.match(result.metadata.warnings[0], /pnpm fal:doctor/);
      assert.ok(result.metadata.warnings[0].includes(endpoint));
      if (scenario.patch?.replacement) assert.ok(result.metadata.warnings[0].includes(replacement));
    } else assert.equal(result.metadata.warnings, undefined);
  });
}
