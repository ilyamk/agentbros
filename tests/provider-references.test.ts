import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { importAsset } from "../src/lib/assets/registry";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import { buildFalOperation } from "../src/lib/providers/fal-operations";
import { generationInputHash } from "../src/lib/jobs/runner";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "provider-ref-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/projects/ref"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/ref/project.json"), "{}");
  const source = path.join(root, "image.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", source]);
  const asset = importAsset({
    rootDir: root,
    projectId: "ref",
    sourceFile: source,
    provenance: { origin: "agent-harness", tool: "Codex" },
  }).asset;
  const request = {
    family: "nano-banana-2.1" as const,
    operation: "edit",
    input: {
      prompt: "Preserve this character and change location",
      image_urls: [`asset://sha256/${asset.hash}`],
    },
  };
  return { root, source, asset, request };
}
test("harness imported ref becomes stable inline input with measured metadata, no upload or fake billing", (t) => {
  const { root, source, asset, request } = fixture(t),
    first = resolveImportedReferences(request, "ref", root),
    second = resolveImportedReferences(request, "ref", root);
  assert.equal(generationInputHash(first.request.input), generationInputHash(second.request.input));
  assert.equal(
    (first.request.input.image_urls as string[])[0],
    `data:image/png;base64,${readFileSync(source).toString("base64")}`,
  );
  assert.deepEqual(first.referenceAssetIds, [asset.id]);
  const url = (first.request.input.image_urls as string[])[0];
  assert.equal(first.request.context!.media[url].width, 64);
  assert.ok(buildFalOperation(first.request).endpoint.includes("nano-banana"));
  assert.match(request.input.image_urls[0], /^asset:\/\//);
});
test("unregistered, unscoped, oversized and altered references fail before submission", (t) => {
  const { root, asset, request } = fixture(t);
  assert.throws(() => resolveImportedReferences(request, undefined, root), /--project/);
  assert.throws(
    () =>
      resolveImportedReferences(
        {
          ...request,
          input: { image_urls: [`asset://sha256/${"0".repeat(64)}`] },
        },
        "ref",
        root,
      ),
    /not registered/,
  );
  assert.throws(() => resolveImportedReferences(request, "ref", root, 1), /exceed/);
  writeFileSync(path.join(root, "public", asset.files.original), "altered");
  assert.throws(() => resolveImportedReferences(request, "ref", root), /mismatch/);
});
test("modern model dry-run resolves local harness refs without API credentials or durable jobs", (t) => {
  const { root, request } = fixture(t),
    file = path.join(root, "request.json");
  writeFileSync(file, JSON.stringify(request));
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/generate-model.ts"),
      "--project",
      "ref",
      "--request",
      file,
      "--output",
      "planned.png",
      "--dry-run",
      "--max-cost-usd",
      "1",
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, FAL_KEY: "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.metadata.dryRun, true);
  assert.match(body.metadata.input.image_urls[0], /^data:image\/png;base64,/);
});

function falKeyframe(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "provider-ref-fal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/projects/x/assets"), { recursive: true });
  const keyframe = path.join(root, "public/projects/x/assets/keyframe.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", keyframe]);
  return { root, keyframe };
}
const falRequest = (start: string) => ({
  endpoint: "blackforestlabs/flux-3/first-last-frame-to-video/draft",
  input: { prompt: "Fly through", start_image_url: start, end_image_url: "https://fal.media/end.png" },
});
test("fal: a plain local keyframe path inlines as a data URI under the working directory", (t) => {
  const { root, keyframe } = falKeyframe(t);
  const result = resolveImportedReferences(falRequest("public/projects/x/assets/keyframe.png"), undefined, root);
  assert.equal(
    result.request.input.start_image_url,
    `data:image/png;base64,${readFileSync(keyframe).toString("base64")}`,
  );
  assert.equal(result.request.input.end_image_url, "https://fal.media/end.png");
});
test("fal: a local path outside the working directory is refused before reading it", (t) => {
  const { root } = falKeyframe(t);
  const outside = mkdtempSync(path.join(os.tmpdir(), "provider-ref-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, "private.png"), "private bytes");
  for (const reference of [path.join(outside, "private.png"), path.relative(root, path.join(outside, "private.png"))])
    assert.throws(
      () => resolveImportedReferences(falRequest(reference), undefined, root),
      /outside|escape|within|scope/i,
    );
});
test("fal: local references over the inline cap fail with the total and the limit", (t) => {
  const { root } = falKeyframe(t);
  assert.throws(
    () => resolveImportedReferences(falRequest("public/projects/x/assets/keyframe.png"), undefined, root, 16),
    /Local references total .* over the .*MiB inline limit/,
  );
});
