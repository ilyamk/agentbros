import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { genjutsuFixture } from "./helpers/genjutsu-preparation";

const repo = path.resolve(import.meta.dirname, "..");
function cli(root: string, script: string, args: string[]) {
  const child = spawnSync(
    process.execPath,
    [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts", script), ...args],
    {
      cwd: root,
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, child.stderr);
  return { status: child.status, json: JSON.parse(lines[0]!) };
}
test("CLI prepares and approves exact inputs; unapproved quote/generation stops before credentials or network", (t) => {
  const f = genjutsuFixture(t),
    spec = f.spec(),
    specFile = path.join(f.rootDir, "spec.json");
  writeFileSync(specFile, JSON.stringify(spec));
  const prepared = cli(f.rootDir, "model-prepare.ts", ["--action", "prepare", "--project", "demo", "--spec", specFile]);
  assert.equal(prepared.status, 0, JSON.stringify(prepared.json));
  assert.equal(prepared.json.metadata.ready, false);
  const directory = path.join(f.project, "pipeline/model-preparations", spec.id),
    request = path.join(directory, "request.json");
  const offline = cli(f.rootDir, "hf-quote.ts", ["--project", "demo", "--request", request]);
  assert.equal(offline.status, 0);
  const estimate = cli(f.rootDir, "hf-quote.ts", ["--project", "demo", "--request", request, "--provider-estimate"]);
  assert.equal(estimate.json.error, "STAGE_INCOMPLETE");
  assert.match(estimate.json.message, /Approve/);
  const live = cli(f.rootDir, "generate-model.ts", [
    "--project",
    "demo",
    "--request",
    request,
    "--output",
    "public/projects/demo/assets/result.mp4",
  ]);
  assert.equal(live.json.error, "STAGE_INCOMPLETE");
  const dry = cli(f.rootDir, "generate-model.ts", [
    "--project",
    "demo",
    "--request",
    request,
    "--output",
    "public/projects/demo/assets/result.mp4",
    "--dry-run",
  ]);
  assert.equal(dry.status, 0);
  assert.equal(dry.json.metadata.executable, false);
  const rights = cli(f.rootDir, "film-rights.ts", [
    "--project",
    "demo",
    "--preparation",
    spec.id,
    "--status",
    "owned",
    "--answer",
    "Fixture-only authorisation of synthetic inputs",
    "--allow-processing",
    "--evidence",
    "Synthetic fixture",
    "--placements",
    "tiktok",
    "--commercial",
    "--audio-rights",
    "muted",
  ]);
  assert.equal(rights.status, 0, JSON.stringify(rights.json));
  const template = JSON.parse(readFileSync(path.join(directory, "visual-review-template.json"), "utf8"));
  const review = {
    ...template,
    reviewer: "fixture",
    evidence: "Synthetic test observations",
    sourceMotionReadable: true,
    targetUnambiguous: true,
    references: template.references.map((ref: { sha256: string }) => ({
      sha256: ref.sha256,
      identityConsistent: true,
      detailReadable: true,
      angleSuitable: true,
      evidence: "Fixture reference",
    })),
  };
  const reviewFile = path.join(f.rootDir, "review.json");
  writeFileSync(reviewFile, JSON.stringify(review));
  const approved = cli(f.rootDir, "model-prepare.ts", [
    "--project",
    "demo",
    "--action",
    "approve",
    "--id",
    spec.id,
    "--review",
    reviewFile,
    "--answer",
    "Fixture-only approval",
  ]);
  assert.equal(approved.status, 0, JSON.stringify(approved.json));
  const checked = cli(f.rootDir, "model-prepare.ts", ["--project", "demo", "--action", "check", "--id", spec.id]);
  assert.equal(checked.status, 0, JSON.stringify(checked.json));
  assert.equal(checked.json.metadata.ready, true);
});
