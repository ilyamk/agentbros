import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { importAsset, readAssetRegistry, hashFile } from "../src/lib/assets/registry";
import { AssetProvenanceSchema } from "../src/types/assets";

function setup(t: test.TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "asset-import-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/test-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const image = path.join(rootDir, "image.png"),
    audio = path.join(rootDir, "audio.wav");
  const make = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  make(["-f", "lavfi", "-i", "color=c=red:s=48x32", "-frames:v", "1", image]);
  make(["-f", "lavfi", "-i", "sine=frequency=500:duration=0.1", audio]);
  return { rootDir, project, image, audio };
}
const code = (name: string) => (error: unknown) => (error as { code?: string }).code === name;

test("harness image original preserved with dimensions and unknown billing; duplicate immutable", (t) => {
  const { rootDir, image } = setup(t);
  const imported = importAsset({
    rootDir,
    projectId: "test-project",
    sourceFile: image,
    provenance: { origin: "agent-harness", tool: "imagegen", model: "unknown", prompt: "Character sheet" },
  });
  assert.equal(imported.asset.kind, "image");
  assert.equal(imported.asset.media.width, 48);
  assert.equal(imported.asset.media.height, 32);
  assert.equal(imported.asset.provenance.billing.status, "unknown");
  assert.equal(imported.asset.provenance.billing.apiUsd, undefined);
  assert.equal(imported.asset.rights.commercialAllowed, "unknown");
  const original = path.join(rootDir, "public", imported.asset.files.original);
  assert.deepEqual(readFileSync(original), readFileSync(image));
  assert.equal(hashFile(original), imported.asset.hash);
  const duplicate = importAsset({
    rootDir,
    projectId: "test-project",
    sourceFile: image,
    provenance: { origin: "manual" },
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.asset, imported.asset);
  assert.equal(readAssetRegistry("test-project", rootDir).revision, 1);
});

test("audio inspection, rights and reference IDs recorded", (t) => {
  const { rootDir, image, audio } = setup(t);
  const ref = importAsset({ rootDir, projectId: "test-project", sourceFile: image, provenance: { origin: "manual" } });
  const imported = importAsset({
    rootDir,
    projectId: "test-project",
    sourceFile: audio,
    provenance: { origin: "stock", referenceAssetIds: [ref.asset.id] },
    rights: {
      licence: "CC0",
      commercialAllowed: true,
      attributionRequired: false,
      sourceUrl: "https://example.test/audio",
      checkedAsOf: new Date().toISOString(),
    },
  });
  assert.equal(imported.asset.kind, "audio");
  assert.equal(imported.asset.media.hasAudio, true);
  assert.equal(imported.asset.media.sampleRate, 44100);
  assert.ok(imported.asset.media.durationSec! > 0);
  assert.equal(imported.asset.rights.commercialAllowed, true);
  assert.equal(readAssetRegistry("test-project", rootDir).assets.length, 2);
});

test("dry-run has no writes; missing source/reference and bogus media rejected", (t) => {
  const { rootDir, image, project } = setup(t);
  const planned = importAsset({
    rootDir,
    projectId: "test-project",
    sourceFile: image,
    provenance: { origin: "manual" },
    dryRun: true,
  });
  assert.equal(planned.dryRun, true);
  assert.equal(existsSync(path.join(project, "pipeline")), false);
  assert.equal(existsSync(path.join(project, "assets")), false);
  assert.throws(
    () => importAsset({ rootDir, projectId: "test-project", sourceFile: "missing", provenance: { origin: "manual" } }),
    code("FILE_NOT_FOUND"),
  );
  assert.throws(
    () =>
      importAsset({
        rootDir,
        projectId: "test-project",
        sourceFile: image,
        provenance: { origin: "manual", referenceAssetIds: ["missing"] },
        dryRun: true,
      }),
    code("FILE_NOT_FOUND"),
  );
  const invalid = path.join(rootDir, "invalid.png");
  writeFileSync(invalid, "not media");
  assert.throws(
    () => importAsset({ rootDir, projectId: "test-project", sourceFile: invalid, provenance: { origin: "manual" } }),
    code("VALIDATION"),
  );
  assert.throws(() =>
    AssetProvenanceSchema.parse({ origin: "agent-harness", billing: { status: "unknown", apiUsd: 0 } }),
  );
});

test("path traversal, escaping destination symlinks and locks block import", (t) => {
  const { rootDir, image, project } = setup(t);
  assert.throws(
    () => importAsset({ rootDir, projectId: "../other", sourceFile: image, provenance: { origin: "manual" } }),
    code("INVALID_INPUT"),
  );
  const outside = path.join(rootDir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(project, "assets"));
  assert.throws(
    () => importAsset({ rootDir, projectId: "test-project", sourceFile: image, provenance: { origin: "manual" } }),
    code("INVALID_INPUT"),
  );
  rmSync(path.join(project, "assets"));
  mkdirSync(path.join(project, "pipeline"));
  writeFileSync(path.join(project, "pipeline/asset-registry.json.lock"), "active");
  assert.throws(
    () => importAsset({ rootDir, projectId: "test-project", sourceFile: image, provenance: { origin: "manual" } }),
    code("TIMEOUT"),
  );
});

test("corrupted originals and registry fail instead of overwrite", (t) => {
  const { rootDir, image, project } = setup(t);
  const result = importAsset({
    rootDir,
    projectId: "test-project",
    sourceFile: image,
    provenance: { origin: "manual" },
  });
  const original = path.join(rootDir, "public", result.asset.files.original);
  writeFileSync(original, "corrupted");
  assert.throws(
    () => importAsset({ rootDir, projectId: "test-project", sourceFile: image, provenance: { origin: "manual" } }),
    code("VALIDATION"),
  );
  assert.equal(readFileSync(original, "utf8"), "corrupted");
  writeFileSync(path.join(project, "pipeline/asset-registry.json"), "{");
  assert.throws(() => readAssetRegistry("test-project", rootDir), code("VALIDATION"));
});

test("video metadata and orphaned blob recovery commit one registry record", (t) => {
  const { rootDir, image, project } = setup(t);
  const video = path.join(rootDir, "clip.mp4");
  const generated = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const clip = importAsset({ rootDir, projectId: "test-project", sourceFile: video, provenance: { origin: "manual" } });
  assert.equal(clip.asset.kind, "video");
  assert.equal(clip.asset.media.width, 64);
  assert.equal(clip.asset.media.hasAudio, false);
  assert.ok(clip.asset.media.durationSec! > 0);
  const plan = importAsset({
    rootDir,
    projectId: "test-project",
    sourceFile: image,
    provenance: { origin: "manual" },
    dryRun: true,
  });
  writeFileSync(path.join(rootDir, "public", plan.asset.files.original), readFileSync(image));
  const recovered = importAsset({
    rootDir,
    projectId: "test-project",
    sourceFile: image,
    provenance: { origin: "manual" },
  });
  assert.equal(recovered.duplicate, false);
  assert.equal(readAssetRegistry("test-project", rootDir).assets.length, 2);
  assert.equal(existsSync(path.join(project, "pipeline/asset-registry.json.lock")), false);
});

test("CLI imports sidecar metadata and emits one machine-readable envelope", (t) => {
  const { rootDir, image } = setup(t);
  const metadata = path.join(rootDir, "sidecar.json");
  writeFileSync(
    metadata,
    JSON.stringify({
      provenance: { origin: "agent-harness", tool: "Codex image tool", model: "unknown" },
      rights: { licence: "unknown" },
    }),
  );
  const cli = path.resolve("scripts/import-asset.ts"),
    runner = path.resolve("node_modules/tsx/dist/cli.mjs");
  const result = spawnSync(
    process.execPath,
    [runner, cli, "--project", "test-project", "--input", image, "--metadata", metadata],
    { cwd: rootDir, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.asset.provenance.origin, "agent-harness");
  for (const output of envelope.outputs) assert.equal(existsSync(path.join(rootDir, output)), true);
});
