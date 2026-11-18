import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, copyFileSync } from "node:fs";
import { prepareViz, exampleViz } from "../src/lib/viz/store";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import { mountVizFilm } from "../src/lib/viz/mount-film";
import { captureBespokeIdentity, bespokeLocalAssets } from "../src/lib/delivery/bespoke";
import { assertVizMotionPlan, vizProjectAdvice } from "../src/lib/viz/integrity";
import { inspectVizEvidence } from "../src/lib/viz/evidence";
import { captureDeliverySnapshot, checkDelivery } from "../src/lib/delivery/service";
import { DeliveryRequestSchema } from "../src/types/delivery";
import { renderClip } from "../src/lib/vision/composition";
const checkout = path.resolve(import.meta.dirname, "..");
function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "viz-process-")));
  mkdirSync(path.join(root, "public/projects/film/pipeline"), { recursive: true });
  return root;
}
const shot = {
  id: "actual-owner",
  startFrame: 0,
  durationFrames: 33,
  intent: "Explain",
  subject: "Measured data",
  framing: "Wide",
  camera: "Static",
  composition: "Data hierarchy",
  entrance: "Reveal",
  exit: "Hold",
  curve: "ease-out",
  route: "remotion",
  transitionToNext: "cut",
};
test("generated bespoke mounting, film gates and delivery identity reject altered consumed props", async () => {
  const root = setup(),
    previous = process.cwd();
  try {
    process.chdir(root);
    const prepared = await prepareViz("film", { ...exampleViz("bars"), durationFrames: 33 });
    const planFile = "public/projects/film/pipeline/motion-plan.json";
    writeFileSync(planFile, JSON.stringify({ schemaVersion: 1, projectId: "film", fps: 30, shots: [shot] }));
    writeFileSync(
      "public/projects/film/pipeline/brief.json",
      JSON.stringify({ renderMode: "bespoke", format: "landscape" }),
    );
    const options = {
      project: "film",
      bundle: prepared.bundle,
      shot: shot.id,
      planHash: hashFile(planFile),
      format: "landscape" as const,
      apply: false,
    };
    assert.deepEqual(mountVizFilm(options).outputs, []);
    assert.equal(JSON.parse(readFileSync(planFile, "utf8")).shots[0].vizBinding, undefined);
    mountVizFilm({ ...options, apply: true });
    const build = JSON.parse(readFileSync("public/projects/film/pipeline/build.json", "utf8"));
    const identity = captureBespokeIdentity("film", "landscape", { rootDir: root });
    assert.ok(identity.sources.some((s) => s.path === `public/${build.props}`));
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    assert.doesNotThrow(() => assertVizMotionPlan(root, "film", plan));
    assert.throws(() => assertVizMotionPlan(root, "film", { ...plan, fps: 24 }), /30fps/);
    assert.equal(vizProjectAdvice(root, "film")!.scenes.length, 1);
    const request = DeliveryRequestSchema.parse({
      version: 1,
      projectId: "film",
      formats: ["landscape"],
      variants: ["captioned"],
      placements: ["youtube"],
      approvalMode: "manual",
      mode: "draft",
      loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: false },
    });
    const snapshot = captureDeliverySnapshot(request, { rootDir: root }).snapshot;
    assert.ok(snapshot.identities[0]!.sources.some((source) => source.path.endsWith("/bundle.json")));
    await prepareViz(
      "film",
      { ...exampleViz("bars"), durationFrames: 33, title: "Inactive revision" },
      { expectedRevision: prepared.bundle.hash },
    );
    assert.equal(captureDeliverySnapshot(request, { rootDir: root }).snapshot.id, snapshot.id);
    const unused = path.join(root, "unmounted.png");
    writeFileSync(
      unused,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    importAsset({ projectId: "film", sourceFile: unused, provenance: { origin: "manual", tool: "viz-plate" } });
    assert.equal(
      captureDeliverySnapshot(request, { rootDir: root }).snapshot.id,
      snapshot.id,
      "Unused managed visualisation imports are advisory for a generated build",
    );
    const unusedVideo = path.join(root, "unused.mp4");
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90:r=30",
        "-frames:v",
        "1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        unusedVideo,
      ]).status,
      0,
    );
    importAsset({ projectId: "film", sourceFile: unusedVideo, provenance: { origin: "manual", tool: "viz-render" } });
    assert.equal(
      captureDeliverySnapshot(request, { rootDir: root }).snapshot.id,
      snapshot.id,
      "Unused managed videos do not change a generated film",
    );
    const propsFile = path.join(root, "public", build.props),
      props = JSON.parse(readFileSync(propsFile, "utf8"));
    props.shots[0].plans[0].primitives[0].fill = "#ff0000";
    writeFileSync(propsFile, JSON.stringify(props));
    assert.throws(() => captureBespokeIdentity("film", "landscape", { rootDir: root }), /content address/);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic metric records verify only the exact mounted owner, record identity and source bytes", async () => {
  const root = setup(),
    previous = process.cwd();
  try {
    process.chdir(root);
    const quantity = { kind: "metric-v1" as const, metricId: "latency", subjectId: "api", unit: "ms", methodId: "p95" };
    const sourceFile = "public/projects/film/pipeline/metrics.json";
    writeFileSync(sourceFile, JSON.stringify({ version: 1, records: [{ id: "record", quantity, value: 24 }] }));
    const citation = { path: sourceFile.slice(7), sha256: hashFile(sourceFile), excerpt: "latency" };
    writeFileSync(
      "public/projects/film/pipeline/workflow-claims.json",
      JSON.stringify({
        version: 1,
        projectId: "film",
        claims: [
          { id: "claim", text: "Measured latency", sceneId: "actual-owner", sourceUrls: [], evidence: [citation] },
        ],
      }),
    );
    const prepared = await prepareViz("film", {
      ...exampleViz("bars"),
      unit: "ms",
      edges: [],
      data: [
        {
          id: "datum",
          label: "Latency",
          value: 24,
          quantity,
          evidence: { ...citation, recordId: "record", claimId: "claim" },
        },
      ],
    });
    const props = { plans: prepared.bundle.plans, vizBinding: { sceneId: "example", revision: prepared.bundle.hash } };
    const consumed = { scenes: [{ id: "actual-owner", template: { id: "scene.visualisation", props } }] };
    assert.deepEqual(inspectVizEvidence(root, "film", consumed).findings, []);
    assert.equal(
      inspectVizEvidence(root, "film", { scenes: [{ id: "other-owner", template: { props } }] }).findings[0]!.code,
      "CHART_SOURCE_REVIEW_REQUIRED",
    );
    writeFileSync(sourceFile, JSON.stringify({ version: 1, records: [{ id: "record", quantity, value: 99 }] }));
    assert.equal(inspectVizEvidence(root, "film", consumed).findings[0]!.code, "CHART_SOURCE_MISMATCH");
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "generated bespoke build renders a real complete clip with shared prepared plans",
  { skip: process.env.RUN_VIZ_RENDER_TESTS !== "1", timeout: 180000 },
  async () => {
    const root = setup(),
      previous = process.cwd();
    try {
      process.chdir(root);
      const prepared = await prepareViz("film", { ...exampleViz("bars"), durationFrames: 33 });
      const plan = "public/projects/film/pipeline/motion-plan.json";
      writeFileSync(plan, JSON.stringify({ schemaVersion: 1, projectId: "film", fps: 30, shots: [shot] }));
      mountVizFilm({
        project: "film",
        bundle: prepared.bundle,
        shot: shot.id,
        planHash: hashFile(plan),
        format: "landscape",
        apply: true,
      });
      const build = JSON.parse(readFileSync("public/projects/film/pipeline/build.json", "utf8"));
      const result = await renderClip(
        {
          entry: path.join(checkout, build.entry),
          composition: build.composition,
          propsFile: path.join(root, "public", build.props),
          publicDir: path.join(root, "public"),
          gl: "angle",
        },
        { output: path.join(root, "film.mp4"), codec: "h264", muted: true },
      );
      assert.equal(result.frameCount, 33);
      assert.equal(result.width, 1920);
      assert.equal(result.height, 1080);
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "cancelled CLI render publishes no clip or receipt and the same immutable revision can retry",
  { skip: process.env.RUN_VIZ_RENDER_TESTS !== "1", timeout: 240000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const root = setup(),
      previous = process.cwd();
    try {
      process.chdir(root);
      const config = JSON.parse(readFileSync(path.join(checkout, "tests/fixtures/legacy/demo/project.json"), "utf8"));
      config.formats = ["landscape"];
      writeFileSync("public/projects/film/project.json", JSON.stringify(config));
      const prepared = await prepareViz("film", { ...exampleViz("bars"), durationFrames: 33 });
      const run = (cancel: boolean) =>
        new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              path.join(checkout, "node_modules/tsx/dist/loader.mjs"),
              path.join(checkout, "scripts/viz-render.ts"),
              "--project",
              "film",
              "--scene",
              "example",
              "--revision",
              prepared.bundle.hash,
            ],
            {
              cwd: root,
              env: {
                AGENTBROS_NO_DOTENV: "1",
                PATH: process.env.PATH,
                AGENTBROS_MEMORY_ROOT: path.join(root, "memory"),
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "",
            sent = false;
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("CLI render deadline exceeded"));
          }, 100000);
          child.stdout.on("data", (chunk) => (stdout += String(chunk)));
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
            if (cancel && !sent && stderr.includes("Render 0%")) {
              sent = true;
              child.kill("SIGTERM");
            }
          });
          child.on("error", reject);
          child.on("close", (status) => {
            clearTimeout(timer);
            if (cancel && !sent) reject(new Error(`Render completed before cancellation: ${stderr}`));
            else resolve({ status, stdout });
          });
        });
      const cancelled = await run(true);
      assert.equal(cancelled.status, 1);
      assert.equal(JSON.parse(cancelled.stdout).ok, false);
      const registryLock = path.join(root, "public/projects/film/pipeline/asset-registry.json.lock");
      writeFileSync(registryLock, "fixture import in progress");
      const refused = await run(false);
      assert.equal(refused.status, 1);
      assert.equal(JSON.parse(refused.stdout).error, "TIMEOUT");
      rmSync(registryLock);
      const retried = await run(false);
      assert.equal(retried.status, 0, retried.stdout);
      const result = JSON.parse(retried.stdout);
      assert.equal(result.ok, true);
      for (const file of result.outputs) assert.ok(existsSync(path.resolve(root, file)));
      const receipt = JSON.parse(readFileSync(path.resolve(root, result.outputs[1]), "utf8"));
      assert.equal(receipt.frameCount, 33);
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("generated file props cannot hide an imported native draft texture from delivery", async () => {
  const { LocalResultReceiptSchema } = await import("../src/types/local-capabilities");
  const root = setup(),
    previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("scripts/blender", { recursive: true });
    copyFileSync(path.join(checkout, "scripts/blender/viz_scene.py"), "scripts/blender/viz_scene.py");
    writeFileSync(
      "public/projects/film/pipeline/brief.json",
      JSON.stringify({ renderMode: "bespoke", format: "landscape" }),
    );
    const source = "public/projects/film/assets/texture.json.assets/generation/texture.png";
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(
      source,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const receipt = LocalResultReceiptSchema.parse({
      version: 1,
      task: "vision.faces",
      backend: "apple-vision",
      operationId: "a".repeat(64),
      createdAt: new Date().toISOString(),
      identity: "b".repeat(64),
      systemModelsHashPinned: false,
      requestHash: "c".repeat(64),
      inputs: [],
      outputs: [{ file: path.resolve(source), sha256: hashFile(source) }],
      purpose: "draft",
      checks: [],
      warnings: [],
    });
    writeFileSync(path.join(path.dirname(source), "receipt.json"), JSON.stringify(receipt) + "\n");
    const asset = importAsset({
      projectId: "film",
      sourceFile: path.resolve(source),
      provenance: { origin: "manual" },
    }).asset;
    const prepared = await prepareViz("film", {
      ...exampleViz("bars-3d"),
      durationFrames: 33,
      textures: {
        version: 1,
        licence: "Fixture only",
        maps: { baseColor: { path: asset.files.original, sha256: asset.hash, colourSpace: "srgb", repeat: [1, 1] } },
      },
    });
    const planFile = "public/projects/film/pipeline/motion-plan.json",
      buildFile = "public/projects/film/pipeline/build.json";
    writeFileSync(planFile, JSON.stringify({ schemaVersion: 1, projectId: "film", fps: 30, shots: [shot] }));
    mountVizFilm({
      project: "film",
      bundle: prepared.bundle,
      shot: shot.id,
      planHash: hashFile(planFile),
      format: "landscape",
      apply: true,
    });
    const build = JSON.parse(readFileSync(buildFile, "utf8"));
    build.localAssets = [];
    writeFileSync(buildFile, JSON.stringify(build));
    assert.throws(() => bespokeLocalAssets(root, "film"), /localAssets/);
    assert.throws(() => captureBespokeIdentity("film", "landscape", { rootDir: root }), /localAssets/);
    build.localAssets = [asset.files.original];
    writeFileSync(buildFile, JSON.stringify(build));
    assert.equal(bespokeLocalAssets(root, "film").length, 1);
    const request = DeliveryRequestSchema.parse({
      version: 1,
      projectId: "film",
      formats: ["landscape"],
      variants: ["captioned"],
      placements: ["youtube"],
      approvalMode: "manual",
      loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: false },
    });
    const snapshot = captureDeliverySnapshot(request, { rootDir: root }).snapshot;
    assert.ok(
      checkDelivery(request, snapshot, { rootDir: root }).blockers.some(
        (finding) => finding.code === "LOCAL_IMPORTED_DRAFT",
      ),
    );
    const unused = await prepareViz(
      "film",
      { ...exampleViz("bars"), durationFrames: 33 },
      { expectedRevision: prepared.bundle.hash },
    );
    mountVizFilm({
      project: "film",
      bundle: unused.bundle,
      shot: shot.id,
      planHash: hashFile(planFile),
      buildHash: hashFile(buildFile),
      format: "landscape",
      apply: true,
    });
    const unusedBuild = JSON.parse(readFileSync(buildFile, "utf8"));
    unusedBuild.localAssets = [];
    writeFileSync(buildFile, JSON.stringify(unusedBuild));
    assert.deepEqual(bespokeLocalAssets(root, "film"), []);
    const unusedSnapshot = captureDeliverySnapshot(request, { rootDir: root }).snapshot;
    assert.ok(
      !checkDelivery(request, unusedSnapshot, { rootDir: root }).blockers.some(
        (finding) => finding.code === "LOCAL_IMPORTED_DRAFT",
      ),
    );
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
