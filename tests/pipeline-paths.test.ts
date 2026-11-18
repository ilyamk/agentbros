import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipelineDir, projectDir, stageArtefactPath } from "../src/lib/pipeline/paths";

const original = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "video-paths-"));
process.chdir(root);
test.after(() => {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
});

test("paths reject traversal, artifact injection and symlink escape", () => {
  for (const id of ["../escape", ".", "", "a/b", "a\\b"]) assert.throws(() => projectDir(id), /Invalid/);
  assert.throws(() => stageArtefactPath("safe", "../../escape", "json"), /Invalid/);
  const outside = mkdtempSync(path.join(tmpdir(), "paths-outside-"));
  try {
    mkdirSync(path.join(root, "public/projects"), { recursive: true });
    symlinkSync(outside, path.join(root, "public/projects/escape"));
    assert.throws(() => pipelineDir("escape"), /escapes|symlink/);
    mkdirSync(path.join(root, "public/projects/escape-pipeline"));
    symlinkSync(outside, path.join(root, "public/projects/escape-pipeline/pipeline"));
    assert.throws(() => pipelineDir("escape-pipeline"), /symlink/);
    assert.equal(existsSync(path.join(outside, "pipeline")), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("pipeline paths reject dangling project, pipeline and artefact links", () => {
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  mkdirSync(path.join(root, "public/projects"), { recursive: true });
  symlinkSync(path.join(outside, "missing-project"), path.join(root, "public/projects/dangling-project"));
  assert.throws(() => projectDir("dangling-project"), /symlink/);
  assert.throws(() => pipelineDir("dangling-project"), /symlink/);
  mkdirSync(path.join(root, "public/projects/dangling-pipeline"));
  symlinkSync(path.join(outside, "missing-pipeline"), path.join(root, "public/projects/dangling-pipeline/pipeline"));
  assert.throws(() => stageArtefactPath("dangling-pipeline", "brief", "json"), /symlink/);
  mkdirSync(path.join(root, "public/projects/dangling-artefact/pipeline"), { recursive: true });
  symlinkSync(
    path.join(outside, "brief.json"),
    path.join(root, "public/projects/dangling-artefact/pipeline/brief.json"),
  );
  assert.throws(() => stageArtefactPath("dangling-artefact", "brief", "json"), /symlink/);
  assert.equal(projectDir("Legacy_Project"), path.join("public/projects", "Legacy_Project"));
  assert.equal(existsSync(path.join(outside, "missing-project")), false);
  assert.equal(existsSync(path.join(outside, "missing-pipeline")), false);
  assert.equal(existsSync(path.join(outside, "brief.json")), false);
});
