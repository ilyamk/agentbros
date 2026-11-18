import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  QualificationCaseSchema,
  QualificationReviewSchema,
  QualificationSuiteSchema,
  maskInset,
  visualQualification,
  evaluateQualification,
} from "../src/lib/vork/qualification";
import { HybridVorkReceiptSchema, NativeVorkReceiptSchema, VorkReceiptSchema, VorkVfxSchema } from "../src/types/vork";
import { assertVorkResult } from "../src/lib/vork/render";
import { hashFile } from "../src/lib/vork/runtime";
import { recipeParams } from "../src/lib/vork/recipes";

const hash = "a".repeat(64),
  pin = { file: "source.json", sha256: hash };
const native = {
  schemaVersion: 1,
  engine: "vork",
  version: "0.5.1",
  purpose: "draft",
  operation: "render",
  createdAt: new Date().toISOString(),
  root: ".",
  tool: pin,
  runtime: [pin],
  inputs: [pin],
  outputs: [pin],
  settings: { profile: "std/final", seed: 42, fps: 25, resolution: [1920, 1080], frames: [0, 124] },
  warnings: [],
  elapsedMs: 1,
  metadata: "meta.json",
};
const row = QualificationCaseSchema.parse({
  id: "shot",
  source: "source.json",
  movie: "render.mp4",
  receipt: "receipt.json",
  duration: 5,
  fps: 25,
  resolution: [1920, 1080],
  criteria: ["composition", "contact"],
  repeat: { receipt: "alone.json", frame: 60 },
});
const review = (reviewer: string, order: "forward" | "reverse") =>
  QualificationReviewSchema.parse({
    schemaVersion: 1,
    reviewer,
    order,
    suiteSha256: hash,
    assessments: [
      {
        id: "shot",
        movieSha256: hash,
        scores: { composition: 4, contact: 4.5 },
        criticalDefects: [],
        observations: "Full clip and receiver reviewed.",
      },
    ],
  });

test("native receipts stay v1 while hybrid renderer identity is explicit and strict", () => {
  assert.equal(NativeVorkReceiptSchema.parse(native).schemaVersion, 1);
  const hybrid = HybridVorkReceiptSchema.parse({
    ...native,
    schemaVersion: 2,
    engine: "vork-blender",
    renderBackend: "blender-cycles",
    blenderVersion: "5.3.0",
    geometryReceipt: pin,
    frameMapping: { sourceFirst: 0, blenderFirst: 11 },
  });
  assert.equal(VorkReceiptSchema.parse(hybrid).schemaVersion, 2);
  assert.equal(VorkReceiptSchema.safeParse({ ...hybrid, engine: "vork" }).success, false);
  assert.equal(VorkReceiptSchema.safeParse({ ...native, renderBackend: "blender-cycles" }).success, false);
  assert.throws(() => assertVorkResult(hybrid, hash, ".", true), /preview-only/);
});
test("final simulation quality and physical rendering are opt-in", () => {
  assert.equal(recipeParams.parse({}).simulationQuality, "preview");
  assert.equal(recipeParams.parse({ simulationQuality: "final" }).simulationQuality, "final");
  assert.equal(recipeParams.safeParse({ simulationQuality: "ultra" }).success, false);
  const request = {
    schemaVersion: 1,
    plate: "plate.mp4",
    camera: "camera.json",
    width: 1920,
    height: 1080,
    duration: 5,
    fps: 25,
  };
  assert.equal(VorkVfxSchema.parse(request).renderBackend, "vork");
  assert.equal(VorkVfxSchema.parse({ ...request, renderBackend: "blender-cycles" }).renderBackend, "blender-cycles");
});
test("a centred subject is measured against every edge; empty and clipped masks fail", () => {
  const mask = new Uint8Array(100 * 60);
  for (let y = 10; y < 50; y++) for (let x = 10; x < 90; x++) mask[y * 100 + x] = 255;
  assert.equal(maskInset(mask, 100, 60).pass, true);
  mask[25 * 100] = 255;
  assert.equal(maskInset(mask, 100, 60).pass, false);
  assert.equal(maskInset(new Uint8Array(6000), 100, 60).pass, false);
  assert.throws(() => maskInset(mask, 10, 10), /dimensions/);
});
test("qualification needs two different opposite-order reviewers with all declared scores >=4", () => {
  const a = review("critic-a", "forward"),
    b = review("critic-b", "reverse");
  assert.equal(visualQualification(row, hash, hash, [a, b]).pass, true);
  for (const reviews of [
    [],
    [a],
    [a, a],
    [a, { ...b, reviewer: a.reviewer }],
    [a, { ...b, order: "forward" as const }],
    [a, { ...b, suiteSha256: "b".repeat(64) }],
  ])
    assert.equal(visualQualification(row, hash, hash, reviews).pass, false);
  for (const assessment of [
    { ...b.assessments[0]!, scores: { composition: 3.9, contact: 5 } },
    { ...b.assessments[0]!, scores: { composition: 5 } },
    { ...b.assessments[0]!, criticalDefects: ["Clipped hero"] },
    { ...b.assessments[0]!, movieSha256: "b".repeat(64) },
  ]) {
    assert.equal(visualQualification(row, hash, hash, [a, { ...b, assessments: [assessment] }]).pass, false);
  }
});
test("qualification rejects duplicate cases/criteria and records missing renders as failures", (t) => {
  assert.equal(QualificationSuiteSchema.safeParse({ schemaVersion: 1, cases: [row, row] }).success, false);
  assert.equal(QualificationCaseSchema.safeParse({ ...row, criteria: ["contact", "contact"] }).success, false);
  const root = mkdtempSync(path.join(tmpdir(), "vork-qualification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "suite.json");
  writeFileSync(input, JSON.stringify({ schemaVersion: 1, cases: [row] }));
  const result = evaluateQualification(input, path.join(root, "report"), [], root);
  assert.equal(result.report.pass, false);
  assert.match(result.report.cases[0]!.error ?? "", /ENOENT/);
  assert.throws(() => evaluateQualification(input, path.join(root, "report"), [], root), /retain/);
  assert.equal(hashFile(input), result.report.suite.sha256);
});
test("hybrid production receipts still reject changed author inputs", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "vork-hybrid-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "sources"));
  const source = path.join(root, "sources", "hero.json");
  writeFileSync(source, "original");
  const sourcePin = { file: "sources/hero.json", sha256: hashFile(source) };
  const geometry = { ...native, purpose: "production", operation: "export", inputs: [sourcePin], outputs: [pin] };
  const geometryFile = path.join(root, "geometry-receipt.json");
  writeFileSync(geometryFile, JSON.stringify(geometry));
  const geometryPin = { file: "geometry-receipt.json", sha256: hashFile(geometryFile) };
  const receipt = {
    ...native,
    purpose: "production",
    schemaVersion: 2,
    engine: "vork-blender",
    renderBackend: "blender-cycles",
    blenderVersion: "5.3.0",
    geometryReceipt: geometryPin,
    frameMapping: { sourceFirst: 0, blenderFirst: 11 },
    inputs: [sourcePin],
    outputs: [pin, geometryPin],
  };
  assert.equal(assertVorkResult(receipt, hash, root, true).schemaVersion, 2);
  writeFileSync(source, "changed");
  assert.throws(() => assertVorkResult(receipt, hash, root, true), /changed/);
});

test("complete movie plus repeatability and favourable reviews cannot bypass a missing framing phase", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { copyFileSync } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "vork-whole-clip-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ffmpeg = (args: string[], input?: Buffer) => {
    const run = spawnSync("ffmpeg", ["-v", "error", ...args], { input, encoding: input ? undefined : "utf8" });
    assert.equal(run.status, 0, String(run.stderr));
  };
  const source = path.join(root, "source.json");
  writeFileSync(source, JSON.stringify({ version: 2, nodes: [], render: { duration: 2 / 30, fps: 30 } }));
  const sourcePin = { file: "source.json", sha256: hashFile(source) };
  for (const directory of ["full", "alone"]) mkdirSync(path.join(root, directory, "frames"), { recursive: true });
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x202030:s=1920x1080,drawbox=x=600:y=300:w=720:h=480:color=0x408090:t=fill",
    "-frames:v",
    "2",
    "-start_number",
    "0",
    path.join(root, "full/frames/%06d.png"),
  ]);
  copyFileSync(path.join(root, "full/frames/000001.png"), path.join(root, "alone/frames/000001.png"));
  ffmpeg([
    "-framerate",
    "30",
    "-start_number",
    "0",
    "-i",
    path.join(root, "full/frames/%06d.png"),
    "-frames:v",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(root, "full/render.mp4"),
  ]);
  const mask = Buffer.alloc(1920 * 1080 * 2, 255);
  for (let y = 300; y < 780; y++) mask.fill(0, (y * 1920 + 600) * 2, (y * 1920 + 1320) * 2);
  ffmpeg(
    [
      "-f",
      "rawvideo",
      "-pixel_format",
      "gray16be",
      "-video_size",
      "1920x1080",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      path.join(root, "full/frames/000000.object_index.png"),
    ],
    mask,
  );
  copyFileSync(
    path.join(root, "full/frames/000000.object_index.png"),
    path.join(root, "full/frames/000001.object_index.png"),
  );
  const makeReceipt = (directory: string, frames: [number, number], files: string[]) => {
    writeFileSync(
      path.join(root, directory, "execution.json"),
      JSON.stringify({
        host: "fixture-host",
        platform: "fixture",
        arch: "fixture",
        osRelease: "fixture",
        backend: "CPU",
      }),
    );
    writeFileSync(
      path.join(root, directory, "frames/meta.json"),
      JSON.stringify({
        object_ids: [
          { name: "model", gltf_node_name: "hero", pass_index: 0 },
          { name: "model", gltf_node_name: "hero", pass_index: 7 },
        ],
      }),
    );
    const outputs = [...files, "execution.json", "frames/meta.json"].map((file) => ({
      file: `${directory}/${file}`,
      sha256: hashFile(path.join(root, directory, file)),
    }));
    const receipt = {
      ...native,
      purpose: "production",
      metadata: `${directory}/frames/meta.json`,
      tool: sourcePin,
      runtime: [sourcePin],
      inputs: [sourcePin],
      outputs,
      settings: { ...native.settings, fps: 30, frames, samples: 16 },
    };
    writeFileSync(path.join(root, directory, "receipt.json"), JSON.stringify(receipt));
  };
  makeReceipt(
    "full",
    [0, 1],
    [
      "frames/000000.png",
      "frames/000001.png",
      "frames/000000.object_index.png",
      "frames/000001.object_index.png",
      "render.mp4",
    ],
  );
  makeReceipt("alone", [1, 1], ["frames/000001.png"]);
  const fixtureCase = {
    ...row,
    fps: 30,
    duration: 2 / 30,
    movie: "full/render.mp4",
    receipt: "full/receipt.json",
    requireActivity: false,
    repeat: { receipt: "alone/receipt.json", frame: 1 },
    framing: {
      maskFiles: ["full/frames/000000.object_index.png", "full/frames/000001.object_index.png"],
      objectIds: [0, 7],
      subjects: ["model/hero"],
      minimumInset: 0.05,
    },
  };
  const input = path.join(root, "suite.json");
  const run = (id: string, shot: unknown) => {
    writeFileSync(input, JSON.stringify({ schemaVersion: 1, cases: [shot] }));
    const reviews = [review("critic-a", "forward"), review("critic-b", "reverse")].map((review, i) => {
      const file = path.join(root, `review-${i}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          ...review,
          suiteSha256: hashFile(input),
          assessments: review.assessments.map((assessment) => ({
            ...assessment,
            movieSha256: hashFile(path.join(root, "full/render.mp4")),
          })),
        }),
      );
      return file;
    });
    return evaluateQualification(input, path.join(root, id), reviews, root).report;
  };
  const complete = run("complete", fixtureCase);
  assert.equal(complete.pass, true, JSON.stringify(complete.cases));
  const pending = run("pending", { ...fixtureCase, framing: undefined });
  assert.equal(pending.pass, false);
  assert.equal(pending.cases[0]!.phases?.completion.pass, true);
  assert.equal(pending.cases[0]!.phases?.visual.pass, true);
  assert.equal(pending.cases[0]!.phases?.framing.pass, false);
  const shortened = run("shortened", { ...fixtureCase, duration: 1 / 30 });
  assert.equal(shortened.pass, false);
  assert.match(shortened.cases[0]!.error ?? "", /partial renders cannot be relabelled/);
});

test("qualification applies the production guard to a hybrid nested geometry export before scoring", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "vork-nested-export-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.json"),
    movie = path.join(root, "render.mp4");
  writeFileSync(source, "{}");
  writeFileSync(movie, "guard fixture");
  const inputPin = { file: "source.json", sha256: hashFile(source) },
    moviePin = { file: "render.mp4", sha256: hashFile(movie) };
  const geometry = { ...native, operation: "export", purpose: "draft", inputs: [inputPin], outputs: [inputPin] };
  const geometryFile = path.join(root, "geometry.json");
  writeFileSync(geometryFile, JSON.stringify(geometry));
  const geometryPin = { file: "geometry.json", sha256: hashFile(geometryFile) };
  writeFileSync(
    path.join(root, "receipt.json"),
    JSON.stringify({
      ...native,
      schemaVersion: 2,
      engine: "vork-blender",
      renderBackend: "blender-cycles",
      purpose: "production",
      blenderVersion: "5.3.0",
      geometryReceipt: geometryPin,
      frameMapping: { sourceFirst: 0, blenderFirst: 11 },
      inputs: [inputPin],
      outputs: [moviePin, geometryPin, inputPin],
    }),
  );
  writeFileSync(path.join(root, "suite.json"), JSON.stringify({ schemaVersion: 1, cases: [row] }));
  const report = evaluateQualification(path.join(root, "suite.json"), path.join(root, "evaluation"), [], root).report;
  assert.equal(report.pass, false);
  assert.match(report.cases[0]!.error ?? "", /draft hybrid geometry/);
});

test("hybrid import retains v2 provenance and production delivery rejects changed sources and drafts", async (t) => {
  const { importAsset } = await import("../src/lib/assets/registry");
  const { assertImportedVorkAssets, captureVorkProvenance } = await import("../src/lib/vork/provenance");
  const { runProcess, digest } = await import("../src/lib/vork/runtime");
  const { readFileSync } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "vork-hybrid-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "out", "result");
  mkdirSync(directory, { recursive: true });
  const project = path.join(root, "public/projects/example");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "pipeline/brief.json"), JSON.stringify({ renderMode: "bespoke" }));
  const source = path.join(root, "hero.json");
  writeFileSync(source, "{}");
  const input = { file: "hero.json", sha256: hashFile(source) };
  const image = path.join(directory, "frame.png");
  await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16", "-frames:v", "1", image]);
  const geometry = path.join(directory, "hero.glb");
  writeFileSync(geometry, "offline export fixture");
  const metadata = path.join(directory, "hybrid-render.json");
  writeFileSync(metadata, "{}");
  const pin = (file: string) => ({ file: path.relative(root, file), sha256: hashFile(file) });
  const exportFile = path.join(directory, "geometry-receipt.json");
  writeFileSync(
    exportFile,
    JSON.stringify({
      ...native,
      purpose: "production",
      operation: "export",
      inputs: [input],
      outputs: [pin(geometry)],
    }),
  );
  const receipt = {
    ...native,
    schemaVersion: 2,
    engine: "vork-blender",
    renderBackend: "blender-cycles",
    purpose: "production",
    blenderVersion: "5.3.0",
    geometryReceipt: pin(exportFile),
    frameMapping: { sourceFirst: 0, blenderFirst: 11 },
    settings: { profile: "blender-cycles", seed: 42, fps: 25, resolution: [16, 16], frames: [0, 0], samples: 16 },
    inputs: [input],
    outputs: [pin(image), pin(geometry), pin(exportFile), pin(metadata)],
    metadata: path.relative(root, metadata),
  };
  writeFileSync(image + ".vork-receipt.json", JSON.stringify(receipt));
  const imported = importAsset({
    projectId: "example",
    sourceFile: image,
    rootDir: root,
    provenance: { origin: "manual", tool: "vork:vfx" },
  });
  assert.equal(imported.asset.vorkResult?.receipt.schemaVersion, 2);
  const original = path.join(root, "public", imported.asset.files.original),
    registry = path.join(project, "pipeline/asset-registry.json");
  assert.doesNotThrow(() => assertImportedVorkAssets([original], registry, root));
  const captured: string[] = [];
  captureVorkProvenance(original, root, (file) => captured.push(file));
  assert.ok(captured.includes(source));
  assert.ok(captured.includes(registry));
  writeFileSync(source, '{"changed":true}');
  assert.throws(() => assertImportedVorkAssets([original], registry, root), /changed/);
  writeFileSync(source, "{}");
  const records = JSON.parse(readFileSync(registry, "utf8"));
  records.assets[0].vorkResult.receipt.purpose = "draft";
  records.assets[0].vorkResult.receiptHash = digest(JSON.stringify(records.assets[0].vorkResult.receipt));
  writeFileSync(registry, JSON.stringify(records));
  assert.throws(() => assertImportedVorkAssets([original], registry, root), /preview-only/);
});
