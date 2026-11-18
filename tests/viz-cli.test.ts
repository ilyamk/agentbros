import { captureVizRenderInputs } from "../src/lib/viz/render-inputs";
import { createVizRenderReceipt } from "../src/lib/viz/receipt";
import { VizBundleSchema } from "../src/types/viz";
import { collectActiveViz } from "../src/lib/viz/usage";
import { ReviewService } from "../src/lib/review-ui/service";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { exampleViz } from "../src/lib/viz/store";
import { importAsset, hashFile } from "../src/lib/assets/registry";
import { COMMANDS } from "../src/mcp/catalog";
import { prepareCommand } from "../src/mcp/bridge";
const checkout = path.resolve(import.meta.dirname, "..");
const run = (cwd: string, action: string, argv: string[] = []) => {
  const result = spawnSync(
    process.execPath,
    [path.join(checkout, "node_modules/tsx/dist/cli.mjs"), path.join(checkout, `scripts/viz-${action}.ts`), ...argv],
    {
      cwd,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, AGENTBROS_MEMORY_ROOT: path.join(cwd, "memory") },
    },
  );
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stderr);
  return { status: result.status, envelope: JSON.parse(lines[0]!) };
};
function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "viz-cli-"));
  mkdirSync(path.join(root, "public/projects/demo/pipeline"), { recursive: true });
  const config = JSON.parse(readFileSync(path.join(checkout, "tests/fixtures/legacy/demo/project.json"), "utf8"));
  config.formats = ["landscape"];
  config.scenes = config.scenes.slice(0, 1);
  config.scenes[0].durationInFrames = 150;
  writeFileSync(path.join(root, "public/projects/demo/project.json"), JSON.stringify(config));
  writeFileSync(path.join(root, "request.json"), JSON.stringify(exampleViz("bars")));
  return root;
}
test("real CLI discovery, no-write preparation and immutable revision inspection", () => {
  const root = workspace();
  try {
    const discovery = run(root, "list", ["--recipe", "bars"]);
    assert.equal(discovery.status, 0);
    assert.equal(discovery.envelope.metadata.example.recipe, "bars");
    assert.equal(run(root, "prepare", ["--project", "demo", "--request", "request.json", "--dry-run"]).status, 0);
    assert.equal(existsSync(path.join(root, "public/projects/demo/pipeline/viz")), false);
    const prepared = run(root, "prepare", ["--project", "demo", "--request", "request.json"]);
    assert.equal(prepared.status, 0);
    const hash = prepared.envelope.metadata.hash;
    assert.equal(run(root, "inspect", ["--project", "demo", "--scene", "example", "--revision", hash]).status, 0);
    assert.equal(run(root, "prepare", ["--project", "demo", "--request", "request.json"]).status, 1);
    assert.equal(run(root, "preview", ["--project", "demo", "--scene", "example", "--dry-run"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("template mounting checks hash and duration before applying", () => {
  const root = workspace();
  try {
    assert.equal(run(root, "prepare", ["--project", "demo", "--request", "request.json"]).status, 0);
    const file = path.join(root, "public/projects/demo/project.json");
    const before = readFileSync(file, "utf8");
    const hash = hashFile(file);
    const args = ["--project", "demo", "--scene", "example", "--target-scene", "hook", "--config-hash", hash];
    assert.equal(run(root, "mount", args).status, 0);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(run(root, "mount", [...args, "--apply", "--dry-run"]).status, 1);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(run(root, "mount", [...args, "--apply"]).status, 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).scenes[0].template.id, "scene.visualisation");
    const service = new ReviewService("demo", root);
    assert.equal(service.state().visualisations!.scenes[0]!.recipe, "bars");
    assert.equal(service.state().visualisations!.factualTruth, "unverified");
    assert.equal(run(root, "mount", [...args, "--apply"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("MCP preparation scopes request and supplies trusted nested-path boundary", () => {
  const root = workspace();
  try {
    const tool = COMMANDS.find((c) => c.name === "viz_prepare")!;
    const options = { root, codeRoot: checkout, projectScope: "demo", allowPaid: false };
    const plan = prepareCommand(tool, { project: "demo", request: "request.json" }, options);
    assert.equal(plan.flags["scope-root"], realpathSync(root));
    assert.throws(() => prepareCommand(tool, { project: "other", request: "request.json" }, options), /scope/);
    assert.throws(() => prepareCommand(tool, { project: "demo", request: "../outside.json" }, options), /escape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("physical multi-format receipts mount at exact fractional duration and survive undo", () => {
  const root = workspace();
  try {
    const configFile = path.join(root, "public/projects/demo/project.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.formats = ["landscape", "vertical"];
    config.scenes[0].durationInFrames = 33;
    writeFileSync(configFile, JSON.stringify(config));
    const spec = { ...exampleViz("bars"), durationFrames: 33, formats: ["landscape", "vertical"] };
    writeFileSync(path.join(root, "request.json"), JSON.stringify(spec));
    const prepared = run(root, "prepare", ["--project", "demo", "--request", "request.json"]);
    assert.equal(prepared.status, 0, JSON.stringify(prepared.envelope));
    const bundleFile = path.resolve(root, prepared.envelope.outputs[0]);
    const bundle = VizBundleSchema.parse(JSON.parse(readFileSync(bundleFile, "utf8")));
    const receipts = [];
    for (const format of ["landscape", "vertical"]) {
      const output = path.join(root, `${format}.mp4`);
      const encoded = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=red:s=${format === "landscape" ? "1920x1080" : "1080x1920"}:r=30`,
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
      assert.equal(encoded.status, 0, encoded.stderr);
      const imported = importAsset({
        projectId: "demo",
        rootDir: root,
        sourceFile: output,
        provenance: { origin: "manual", tool: "fixture" },
      });
      const receipt = path.join(root, `${format}.json`);
      writeFileSync(
        receipt,
        JSON.stringify(
          createVizRenderReceipt(
            {
              revision: bundle.hash,
              source: bundleFile,
              renderInputs: captureVizRenderInputs(
                root,
                bundleFile,
                bundle.plans.find((p) => p.format === format)!,
              ),
              backend: "svg",
              format: format as "landscape" | "vertical",
              output,
              sha256: hashFile(output),
              assetId: imported.asset.id,
              id: "VizScene",
              width: format === "landscape" ? 1920 : 1080,
              height: format === "landscape" ? 1080 : 1920,
              durationInFrames: 33,
              frameCount: 33,
              fps: 30,
              firstFrame: 0,
              lastFrame: 32,
            },
            bundle.plans.find((p) => p.format === format)!,
          ),
        ),
      );
      receipts.push({ format, receipt });
    }
    writeFileSync(path.join(root, "receipts.json"), JSON.stringify({ version: 1, receipts }));
    const journal = path.join(root, "public/projects/demo/pipeline/timeline-edit.json");
    const store = new TimelineEditStore(journal);
    store.initialize({
      version: 1,
      projectId: "demo",
      timebase: { num: 30, den: 1 },
      tracks: [
        {
          id: "visual",
          kind: "visual",
          clips: [
            {
              id: "a",
              assetId: "plain",
              start: { num: 0, den: 1 },
              source: { start: { num: 1, den: 10 }, end: { num: 6, den: 5 }, timebase: { num: 1, den: 1 } },
              rate: { num: 1, den: 1 },
              transition: { kind: "cut" },
              captions: [],
            },
          ],
        },
      ],
    });
    const args = [
      "--project",
      "demo",
      "--scene",
      "example",
      "--track",
      "visual",
      "--clip",
      "a",
      "--timeline-revision",
      "0",
      "--receipts",
      "receipts.json",
    ];
    const proposed = run(root, "mount", args);
    assert.equal(proposed.status, 0, JSON.stringify(proposed.envelope));
    assert.equal(store.read().revision, 0);
    const mounted = run(root, "mount", [...args, "--apply"]);
    assert.equal(mounted.status, 0, JSON.stringify(mounted.envelope));
    assert.equal(collectActiveViz(root, "demo", store.read().timeline).length, 2);
    assert.equal(store.undo(1).timeline.tracks[0].clips[0].assetId, "plain");
    assert.ok(store.redo(2).timeline.tracks[0]!.clips[0]!.payload?.vizBinding);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
