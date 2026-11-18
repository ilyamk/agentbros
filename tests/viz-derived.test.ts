import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { VizFormatSchema } from "../src/types/viz";
import { prepareViz, exampleViz } from "../src/lib/viz/store";
import { planDerivedViz, writeDerivedVizFiles } from "../src/lib/viz/derive";
import { collectActiveViz, captureVizDependencies } from "../src/lib/viz/usage";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import { createVizRenderReceipt, validateVizRenderReceipt } from "../src/lib/viz/receipt";
import { captureVizRenderInputs } from "../src/lib/viz/render-inputs";
const fixture = readFileSync(path.resolve(import.meta.dirname, "fixtures/legacy/demo/project.json"), "utf8");
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "viz-derived-full-"));
  for (const project of ["source", "target", "third"]) {
    mkdirSync(path.join(root, "public/projects", project, "pipeline"), { recursive: true });
    writeFileSync(path.join(root, "public/projects", project, "project.json"), fixture);
  }
  return root;
}
test("native derivation remaps texture, evidence and owner before hashes and survives source cleanup", async () => {
  const root = setup(),
    previous = process.cwd();
  try {
    process.chdir(root);
    mkdirSync("public/projects/source/assets", { recursive: true });
    writeFileSync(
      "public/projects/source/assets/paper.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const textureHash = hashFile("public/projects/source/assets/paper.png");
    const quantity = { kind: "metric-v1" as const, metricId: "latency", subjectId: "app", unit: "ms", methodId: "p95" };
    const evidence = "public/projects/source/pipeline/source.json";
    writeFileSync(evidence, JSON.stringify({ version: 1, records: [{ id: "record", quantity, value: 24 }] }));
    const evidenceHash = hashFile(evidence);
    const prepared = await prepareViz("source", {
      ...exampleViz("bars"),
      unit: "ms",
      edges: [],
      data: [
        {
          id: "one",
          label: "Latency",
          value: 24,
          quantity,
          evidence: {
            claimId: "claim",
            path: evidence.slice(7),
            sha256: evidenceHash,
            recordId: "record",
            excerpt: "latency",
          },
        },
      ],
      textures: {
        version: 1,
        licence: "CC0-1.0",
        maps: {
          baseColor: {
            path: "projects/source/assets/paper.png",
            sha256: textureHash,
            colourSpace: "srgb",
            repeat: [1, 1],
          },
        },
      },
    });
    const props = { plans: prepared.bundle.plans, vizBinding: { sceneId: "example", revision: prepared.bundle.hash } };
    const timeline = {
      tracks: [
        {
          clips: [
            {
              id: "episode-owner",
              assetId: "scene:original",
              source: {},
              payload: { scene: { id: "original-owner", template: { id: "scene.visualisation", props } } },
            },
          ],
        },
      ],
    };
    const before = JSON.stringify(timeline);
    const planned = planDerivedViz(root, "source", "target", timeline, ["landscape"]);
    assert.equal(JSON.stringify(timeline), before);
    const targetDirectory = path.join(process.cwd(), "public/projects/target");
    writeDerivedVizFiles(targetDirectory, planned.files);
    const active = collectActiveViz(root, "target", planned.timeline)[0]!;
    assert.notEqual(active.bundle.hash, prepared.bundle.hash);
    assert.equal(active.ownerSceneId, "episode-owner");
    const datum = active.bundle.plans[0]!.spec.data[0]!;
    assert.equal(datum.evidence!.claimId, "claim:episode-owner");
    assert.match(datum.evidence!.path, /projects\/target\/pipeline\/evidence/);
    assert.equal(active.bundle.plans[0]!.spec.textures!.maps.baseColor!.sha256, textureHash);
    rmSync("public/projects/source", { recursive: true });
    const captured: string[] = [];
    captureVizDependencies(root, "target", planned.timeline, (file) => captured.push(file));
    assert.ok(captured.length >= 3);
    assert.ok(captured.every((file) => !file.includes("/projects/source/")));
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("rendered derivation archives receipt ancestry and remains valid after deleting original project", async () => {
  const root = setup(),
    previous = process.cwd();
  try {
    process.chdir(root);
    const prepared = await prepareViz("source", { ...exampleViz("bars"), durationFrames: 33 });
    const output = path.join(root, "public/projects/source/plate.mp4");
    const processResult = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=1920x1080:r=30",
        "-frames:v",
        "33",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(processResult.status, 0, processResult.stderr);
    const imported = importAsset({
      projectId: "source",
      sourceFile: output,
      provenance: { origin: "manual", tool: "fixture" },
    });
    const plan = prepared.bundle.plans[0]!;
    const receipt = createVizRenderReceipt(
      {
        revision: prepared.bundle.hash,
        format: "landscape",
        backend: "svg",
        source: prepared.path,
        renderInputs: captureVizRenderInputs(root, prepared.path, plan),
        output,
        sha256: imported.asset.hash,
        assetId: imported.asset.id,
        id: "VizScene",
        width: 1920,
        height: 1080,
        durationInFrames: 33,
        fps: 30,
        firstFrame: 0,
        lastFrame: 32,
        frameCount: 33,
      },
      plan,
    );
    const receiptFile = `public/projects/source/pipeline/receipt.json`;
    writeFileSync(receiptFile, JSON.stringify(receipt));
    const timeline = {
      tracks: [
        {
          clips: [
            {
              id: "episode-owner",
              assetId: imported.asset.id,
              source: {},
              payload: {
                vizBinding: {
                  sceneId: "example",
                  revision: prepared.bundle.hash,
                  renderReceipt: { path: receiptFile.slice(7), sha256: hashFile(receiptFile) },
                },
              },
            },
          ],
        },
      ],
    };
    const planned = planDerivedViz(root, "source", "target", timeline, ["landscape"]);
    const transferred = importAsset({
      projectId: "target",
      sourceFile: output,
      provenance: { origin: "manual", tool: "derived-fixture" },
    });
    assert.equal(transferred.asset.id, imported.asset.id);
    writeDerivedVizFiles(path.join(process.cwd(), "public/projects/target"), planned.files);
    const active = collectActiveViz(root, "target", planned.timeline)[0]!;
    const derivedReceipt = JSON.parse(readFileSync(active.receiptFile!, "utf8"));
    assert.equal(derivedReceipt.kind, "derived-viz-binding-v1");
    assert.ok(active.ancestryFiles!.length >= 2);
    rmSync("public/projects/source", { recursive: true });
    assert.doesNotThrow(() => collectActiveViz(root, "target", planned.timeline));
    const third = planDerivedViz(root, "target", "third", planned.timeline, ["landscape"]);
    importAsset({
      projectId: "third",
      sourceFile: transferred.asset.files.original.startsWith("projects/")
        ? path.join(root, "public", transferred.asset.files.original)
        : transferred.asset.files.original,
      provenance: { origin: "manual", tool: "derived-fixture" },
    });
    writeDerivedVizFiles(path.join(root, "public/projects/third"), third.files);
    assert.ok(collectActiveViz(root, "third", third.timeline)[0]!.ancestryFiles!.length >= 4);
    const original = readFileSync(active.ancestryFiles![0]!);
    writeFileSync(active.ancestryFiles![0]!, Buffer.from("{}"));
    assert.throws(() => validateVizRenderReceipt(derivedReceipt, active.bundle, active.file), /ancestry/);
    writeFileSync(active.ancestryFiles![0]!, original);
    rmSync("public/projects/target", { recursive: true });
    assert.doesNotThrow(() => collectActiveViz(root, "third", third.timeline));
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
test("full shorts workflow plans, creates and replays native graph closure without treating edge IDs as paths", async (t) => {
  const { shortsFixture } = await import("./workflow-shorts-series.fixture");
  const { inspectShortsSeriesSource, runShortsSeriesWorkflow, assertShortsSeriesReady } =
    await import("../src/lib/workflows/shorts-series");
  const f = shortsFixture(t),
    previous = process.cwd();
  try {
    process.chdir(f.root);
    const data = [
      { id: "a", label: "Input", value: 10 },
      { id: "b", label: "Output", value: 20 },
    ];
    const prepared = await prepareViz("source", {
      ...exampleViz("network"),
      layout: "force",
      durationFrames: 120,
      formats: ["landscape", "vertical", "square"],
      data,
      edges: [{ id: "flow", source: "a", target: "b", value: 1 }],
    });
    f.timeline.overlays = [
      {
        id: "graph",
        block: "viz-scene",
        start: { num: 0, den: 1 },
        end: { num: 120, den: 1 },
        layer: "below-captions",
        props: {
          plans: prepared.bundle.plans,
          ground: "transparent",
          vizBinding: { sceneId: "example", revision: prepared.bundle.hash },
        },
      },
    ];
    writeFileSync(
      path.join(f.directory, "pipeline/timeline-edit.json"),
      JSON.stringify({ version: 1, revision: 4, timeline: f.timeline, undo: [], redo: [] }),
    );
    const inspected = inspectShortsSeriesSource("source", "pipeline/chapters.json", { rootDir: f.root });
    f.request.source = inspected.source;
    for (const episode of f.request.episodes) episode.approvedSourceHash = inspected.approvalSourceHash;
    assert.deepEqual(runShortsSeriesWorkflow(f.request, { action: "plan", rootDir: f.root }).outputs, []);
    const created = runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
    assert.equal(created.metadata.state, "committed");
    for (const episode of f.request.episodes) {
      const directory = path.join(f.root, "public/projects", `${f.request.seriesId}-${episode.selection.id}`);
      assertShortsSeriesReady(directory, { rootDir: f.root, timeline: true });
      const manifest = JSON.parse(readFileSync(path.join(directory, "pipeline/viz/derived-manifest.json"), "utf8"));
      assert.ok(manifest.files.length);
      const journal = JSON.parse(readFileSync(path.join(directory, "pipeline/timeline-edit.json"), "utf8"));
      assert.ok(collectActiveViz(f.root, `${f.request.seriesId}-${episode.selection.id}`, journal.timeline).length);
    }
    assert.equal(runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root }).metadata.idempotent, true);
  } finally {
    process.chdir(previous);
  }
});

test("full shorts workflow carries every rendered variant even when the primary clip is vertical", async (t) => {
  const { shortsFixture } = await import("./workflow-shorts-series.fixture");
  const { inspectShortsSeriesSource, runShortsSeriesWorkflow, assertShortsSeriesReady } =
    await import("../src/lib/workflows/shorts-series");
  const { planProjectRender } = await import("../src/lib/render-plan");
  const f = shortsFixture(t),
    previous = process.cwd();
  try {
    process.chdir(f.root);
    const prepared = await prepareViz("source", {
      ...exampleViz("bars"),
      durationFrames: 120,
      formats: ["vertical", "landscape", "square"],
    });
    const variants: Record<
      string,
      {
        assetId: string;
        vizBinding: { sceneId: string; revision: string; renderReceipt: { path: string; sha256: string } };
      }
    > = {};
    for (const plan of prepared.bundle.plans) {
      const output = path.join(f.directory, `${plan.format}.mp4`);
      const encoded = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=blue:s=${plan.width}x${plan.height}:r=30`,
          "-frames:v",
          "120",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          output,
        ],
        { encoding: "utf8" },
      );
      assert.equal(encoded.status, 0, encoded.stderr);
      const imported = importAsset({
        projectId: "source",
        sourceFile: output,
        provenance: { origin: "manual", tool: "fixture" },
      });
      const receiptFile = path.join(f.directory, "pipeline", `${plan.format}-receipt.json`);
      writeFileSync(
        receiptFile,
        JSON.stringify(
          createVizRenderReceipt(
            {
              revision: prepared.bundle.hash,
              format: plan.format,
              backend: "svg",
              source: prepared.path,
              renderInputs: captureVizRenderInputs(f.root, prepared.path, plan),
              output,
              sha256: imported.asset.hash,
              assetId: imported.asset.id,
              id: "VizScene",
              width: plan.width,
              height: plan.height,
              fps: 30,
              durationInFrames: 120,
              firstFrame: 0,
              lastFrame: 119,
              frameCount: 120,
            },
            plan,
          ),
        ),
      );
      variants[plan.format] = {
        assetId: imported.asset.id,
        vizBinding: {
          sceneId: "example",
          revision: prepared.bundle.hash,
          renderReceipt: {
            path: path.relative(path.join(f.root, "public"), receiptFile),
            sha256: hashFile(receiptFile),
          },
        },
      };
    }
    const clip = f.timeline.tracks[0]!.clips[0]!;
    clip.assetId = variants.vertical!.assetId;
    clip.payload = { vizBinding: variants.vertical!.vizBinding, vizRenderVariants: variants };
    writeFileSync(
      path.join(f.directory, "pipeline/timeline-edit.json"),
      JSON.stringify({ version: 1, revision: 4, timeline: f.timeline, undo: [], redo: [] }),
    );
    const inspected = inspectShortsSeriesSource("source", "pipeline/chapters.json", { rootDir: f.root });
    for (const variant of Object.values(variants))
      assert.ok(inspected.dependencies.some((d) => d.record?.id === variant.assetId));
    f.request.source = inspected.source;
    for (const episode of f.request.episodes) episode.approvedSourceHash = inspected.approvalSourceHash;
    runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
    for (const episode of f.request.episodes) {
      const id = `${f.request.seriesId}-${episode.selection.id}`,
        directory = path.join(f.root, "public/projects", id);
      assertShortsSeriesReady(directory, { rootDir: f.root, timeline: true });
      for (const format of episode.formats) {
        const plan = planProjectRender(id, VizFormatSchema.parse(format), f.root, { timeline: true });
        assert.ok(plan.jobs.length);
        const journal = JSON.parse(readFileSync(path.join(directory, "pipeline/timeline-edit.json"), "utf8"));
        assert.equal(collectActiveViz(f.root, id, journal.timeline).length, 3);
      }
    }
    assert.equal(runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root }).metadata.idempotent, true);
  } finally {
    process.chdir(previous);
  }
});

test("native texture provenance survives repeated derivation and deletion of ancestors", async () => {
  const { LocalResultReceiptSchema } = await import("../src/types/local-capabilities");
  const { assertImportedLocalAssets } = await import("../src/lib/apple/provenance");
  for (const purpose of ["draft", "production"] as const) {
    const root = setup(),
      previous = process.cwd();
    try {
      process.chdir(root);
      const source = "public/projects/source/assets/texture.json.assets/generation/texture.png";
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
        backend: "fixture",
        operationId: "a".repeat(64),
        createdAt: new Date().toISOString(),
        identity: "b".repeat(64),
        systemModelsHashPinned: false,
        requestHash: "c".repeat(64),
        inputs: [],
        outputs: [{ file: path.resolve(source), sha256: hashFile(source) }],
        purpose,
        checks: [],
        warnings: [],
      });
      writeFileSync(path.join(path.dirname(source), "receipt.json"), JSON.stringify(receipt) + "\n");
      const imported = importAsset({
        projectId: "source",
        sourceFile: path.resolve(source),
        provenance: { origin: "manual" },
      }).asset;
      const prepared = await prepareViz("source", {
        ...exampleViz("bars"),
        textures: {
          version: 1,
          licence: "Fixture",
          maps: {
            baseColor: { path: imported.files.original, sha256: imported.hash, colourSpace: "srgb", repeat: [1, 1] },
          },
        },
      });
      const consumed = {
        plans: prepared.bundle.plans,
        vizBinding: { sceneId: "example", revision: prepared.bundle.hash },
      };
      const target = planDerivedViz(root, "source", "target", consumed, ["landscape"]);
      assert.equal(target.assets[0]!.localResult!.receiptHash, imported.localResult!.receiptHash);
      writeDerivedVizFiles(path.join(root, "public/projects/target"), target.files);
      const third = planDerivedViz(root, "target", "third", target.timeline, ["landscape"]);
      writeDerivedVizFiles(path.join(root, "public/projects/third"), third.files);
      rmSync("public/projects/source", { recursive: true });
      rmSync("public/projects/target", { recursive: true });
      const files: string[] = [];
      captureVizDependencies(root, "third", third.timeline, (file, role) => {
        if (role === "asset") files.push(file);
      });
      const registry = path.join(root, "public/projects/third/pipeline/asset-registry.json");
      const actual = JSON.parse(readFileSync(registry, "utf8"));
      assert.deepEqual(actual.assets[0].localResult, imported.localResult);
      assert.ok(files.some((file) => file.includes("/assets/imported/")));
      if (purpose === "draft") assert.throws(() => assertImportedLocalAssets(files, registry, root), /draft/);
      else assert.doesNotThrow(() => assertImportedLocalAssets(files, registry, root));
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("full shorts publication preserves native texture provenance with and without a duplicate media dependency", async (t) => {
  const { shortsFixture } = await import("./workflow-shorts-series.fixture");
  const { inspectShortsSeriesSource, runShortsSeriesWorkflow, assertShortsSeriesReady } =
    await import("../src/lib/workflows/shorts-series");
  const { LocalResultReceiptSchema } = await import("../src/types/local-capabilities");
  const { assertImportedLocalAssets } = await import("../src/lib/apple/provenance");
  for (const duplicate of [false, true]) {
    const f = shortsFixture(t),
      previous = process.cwd();
    try {
      process.chdir(f.root);
      const source = path.join(f.directory, "assets/texture.json.assets/generation/texture.png");
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
        backend: "fixture",
        operationId: "a".repeat(64),
        createdAt: new Date().toISOString(),
        identity: "b".repeat(64),
        systemModelsHashPinned: false,
        requestHash: "c".repeat(64),
        inputs: [],
        outputs: [{ file: source, sha256: hashFile(source) }],
        purpose: "draft",
        checks: [],
        warnings: [],
      });
      writeFileSync(path.join(path.dirname(source), "receipt.json"), JSON.stringify(receipt) + "\n");
      const asset = importAsset({ projectId: "source", sourceFile: source, provenance: { origin: "manual" } }).asset;
      const prepared = await prepareViz("source", {
        ...exampleViz("bars"),
        durationFrames: 120,
        formats: ["vertical", "square"],
        textures: {
          version: 1,
          licence: "Fixture",
          maps: { baseColor: { path: asset.files.original, sha256: asset.hash, colourSpace: "srgb", repeat: [1, 1] } },
        },
      });
      f.timeline.overlays = [
        {
          id: "native-chart",
          block: "viz-scene",
          start: { num: 0, den: 1 },
          end: { num: 120, den: 1 },
          layer: "below-captions",
          props: {
            plans: prepared.bundle.plans,
            ground: "transparent",
            vizBinding: { sceneId: "example", revision: prepared.bundle.hash },
          },
        },
      ];
      if (duplicate) {
        const configFile = path.join(f.directory, "project.json");
        const config = JSON.parse(readFileSync(configFile, "utf8"));
        config.scenes[0].imageUrl = asset.files.original;
        writeFileSync(configFile, JSON.stringify(config));
      }
      writeFileSync(
        path.join(f.directory, "pipeline/timeline-edit.json"),
        JSON.stringify({ version: 1, revision: 4, timeline: f.timeline, undo: [], redo: [] }),
      );
      const inspected = inspectShortsSeriesSource("source", "pipeline/chapters.json", { rootDir: f.root });
      assert.equal(
        inspected.dependencies.some((dependency) => dependency.hash === asset.hash),
        duplicate,
      );
      f.request.source = inspected.source;
      for (const episode of f.request.episodes) episode.approvedSourceHash = inspected.approvalSourceHash;
      runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
      assert.equal(runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root }).metadata.idempotent, true);
      rmSync(f.directory, { recursive: true });
      for (const episode of f.request.episodes) {
        const id = `${f.request.seriesId}-${episode.selection.id}`,
          directory = path.join(f.root, "public/projects", id);
        assertShortsSeriesReady(directory, { rootDir: f.root, timeline: true });
        const journal = JSON.parse(readFileSync(path.join(directory, "pipeline/timeline-edit.json"), "utf8")),
          registry = path.join(directory, "pipeline/asset-registry.json");
        assert.equal(
          JSON.parse(readFileSync(registry, "utf8")).assets.filter(
            (record: { hash: string }) => record.hash === asset.hash,
          ).length,
          1,
        );
        const consumed: string[] = [];
        captureVizDependencies(f.root, id, journal.timeline, (file, role) => {
          if (role === "asset") consumed.push(file);
        });
        assert.throws(() => assertImportedLocalAssets(consumed, registry, f.root), /draft/);
      }
    } finally {
      process.chdir(previous);
    }
  }
});
