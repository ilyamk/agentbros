import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { planDerivative, runDerivative, showDerivative } from "../src/lib/references/derive";
import { DerivativeReceiptSchema, type DerivationStep } from "../src/types/references";
import { derivativeFixture as fixture, hasFfmpeg } from "./helpers/reference-derive";
import { AssetProvenanceSchema } from "../src/types/assets";

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;

test("plan walks the kind state machine, writes nothing and marks a leading fal step paid", media, (t) => {
  const f = fixture(t);
  const plan = planDerivative(
    "demo",
    f.spec("plan-a", [
      { op: "depth-video", engine: "fal" },
      { op: "trim", startSec: 0.5, durationSec: 2 },
      { op: "extract-frame", at: "last" },
    ]),
    f.rootDir,
  );
  assert.equal(plan.existing, "none");
  assert.equal(plan.runnable, true);
  assert.equal(plan.spend, "may-spend");
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.engine, step.status, step.outputKind]),
    [
      ["depth-video", "fal", "paid", "video"],
      ["trim", "ffmpeg", "ready", "video"],
      ["extract-frame", "ffmpeg", "ready", "image"],
    ],
  );
  assert.equal(plan.input.sha256, f.clip.hash);
  assert.equal(plan.output.kind, "image");
  assert.ok(!existsSync(path.join(f.project, "pipeline/reference-derivatives")));
  // Invalid chains are refused by plan, naming the step.
  assert.throws(
    () =>
      planDerivative(
        "demo",
        f.spec("plan-b", [
          { op: "extract-frame", at: "first" },
          { op: "trim", startSec: 0, durationSec: 1 },
        ]),
        f.rootDir,
      ),
    /Step 2 \(trim\)/,
  );
  assert.throws(
    () => planDerivative("demo", f.spec("plan-c", [{ op: "trim", startSec: 2, durationSec: 2 }]), f.rootDir),
    /runs past/,
  );
  assert.throws(
    () => planDerivative("demo", f.spec("plan-d", [{ op: "scale", width: 101, height: 100, fit: "exact" }]), f.rootDir),
    /even dimensions.*snap/,
  );
});

test("run refuses unbuilt steps with INVALID_INPUT", media, async (t) => {
  const f = fixture(t);
  for (const step of [
    { op: "depth-video", engine: "local" },
    { op: "pose-video", engine: "local" },
    { op: "mask-video", engine: "matte-onnx" },
    { op: "audio-clean", engine: "local" },
    { op: "edge-video", kind: "lineart" },
  ] as DerivationStep[])
    await assert.rejects(
      runDerivative("demo", f.spec("unbuilt", [step]), f.rootDir),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, "INVALID_INPUT");
        assert.match(error.message, /not-implemented/);
        return true;
      },
    );
  assert.ok(!existsSync(path.join(f.project, "pipeline/reference-derivatives/unbuilt")));
});

test(
  "local ffmpeg derivatives: video chain, frames, flatten, audio, contact sheet; registry and receipts",
  media,
  async (t) => {
    const f = fixture(t);
    const video = await runDerivative(
      "demo",
      f.spec("wan-source", [
        { op: "trim", startSec: 0.5, durationSec: 2 },
        { op: "scale", width: 250, height: 190, fit: "pad" },
        { op: "snap", multipleOf: 16 },
      ]),
      f.rootDir,
    );
    assert.equal(video.reused, false);
    assert.equal(video.receipt.output.width, 240);
    assert.equal(video.receipt.output.height, 176);
    assert.equal(video.receipt.output.hasAudio, true);
    assert.ok(Math.abs(video.receipt.output.durationSec! - 2) < 0.15, String(video.receipt.output.durationSec));
    assert.equal(video.receipt.engine.kind, "ffmpeg");
    assert.match(video.receipt.engine.version, /^ffmpeg version /);
    assert.equal(video.receipt.costUsd, null);
    assert.equal(video.receipt.input.sha256, f.clip.hash);
    DerivativeReceiptSchema.parse(JSON.parse(readFileSync(path.join(video.directory, "receipt.json"), "utf8")));

    // Registry: origin derivative, receipt link, input lineage.
    const registered = readAssetRegistry("demo", f.rootDir).assets.find(
      (asset) => asset.id === video.receipt.output.assetId,
    )!;
    assert.equal(registered.provenance.origin, "derivative");
    assert.equal(registered.provenance.derivative?.id, "wan-source");
    assert.equal(registered.provenance.derivative?.receipt, "pipeline/reference-derivatives/wan-source/receipt.json");
    assert.equal(registered.provenance.derivative?.specSha256, video.receipt.specSha256);
    assert.deepEqual(registered.provenance.referenceAssetIds, [f.clip.id]);
    assert.throws(() => AssetProvenanceSchema.parse({ origin: "derivative", tool: "x" }), /derivative/);

    // Board: escaped, relative previews, no scripts.
    const board = readFileSync(path.join(video.directory, "board.html"), "utf8");
    assert.doesNotMatch(board, /<script/i);
    assert.match(board, /src="\.\.\/\.\.\/\.\.\/assets\/imported\/[a-f0-9]{64}\.mp4"/);

    // Chained from the previous derivative: the last frame as PNG.
    const last = await runDerivative(
      "demo",
      f.spec("last-frame", [{ op: "extract-frame", at: "last" }], { derivativeId: "wan-source" }),
      f.rootDir,
    );
    assert.equal(last.receipt.output.contentType, "image/png");
    assert.equal(last.receipt.output.width, 240);
    assert.equal(last.receipt.input.assetId, video.receipt.output.assetId);
    assert.equal(last.receipt.measurements.extractedFrame, video.receipt.output.frameCount! - 1);

    const flat = await runDerivative(
      "demo",
      f.spec("flat", [{ op: "flatten", background: "#00FF00" }], { assetId: f.still.id }),
      f.rootDir,
    );
    const flatAsset = readAssetRegistry("demo", f.rootDir).assets.find(
      (asset) => asset.id === flat.receipt.output.assetId,
    )!;
    assert.equal(flatAsset.media.hasAlpha, false);
    assert.equal(flat.receipt.output.width, 64);

    const silent = await runDerivative("demo", f.spec("silent", [{ op: "strip-audio" }]), f.rootDir);
    assert.equal(silent.receipt.output.hasAudio, false);
    assert.equal(silent.receipt.output.contentType, "video/mp4");

    const voice = await runDerivative(
      "demo",
      f.spec("voice", [
        { op: "audio-trim", startSec: 0.5, durationSec: 1.5 },
        { op: "loudness", lufs: -23 },
      ]),
      f.rootDir,
    );
    assert.equal(voice.receipt.output.contentType, "audio/wav");
    assert.equal(voice.receipt.output.width, undefined);
    assert.ok(Math.abs(voice.receipt.output.durationSec! - 1.5) < 0.05);
    assert.equal(voice.receipt.measurements.loudnessTargetLufs, -23);
    assert.ok(Math.abs(voice.receipt.measurements.loudnessOutputLufs! + 23) < 2, JSON.stringify(voice.receipt));
    assert.equal(typeof voice.receipt.measurements.loudnessInputLufs, "number");

    const sheet = await runDerivative("demo", f.spec("sheet", [{ op: "contact-sheet", columns: 3 }]), f.rootDir);
    assert.equal(sheet.receipt.output.contentType, "image/png");
    assert.equal(sheet.receipt.measurements.contactSheetFrames, 9);
    assert.equal(sheet.receipt.output.width, 3 * 320 + 4 * 4);

    // show reads the stored receipt.
    const shown = showDerivative("demo", "sheet", f.rootDir);
    assert.equal(shown.sha256, sheet.sha256);

    // AC7: every spec above, run again under a new id, gives the same output bytes.
    for (const first of [video, last, flat, silent, voice, sheet]) {
      const spec = showDerivative("demo", first.receipt.id, f.rootDir).spec;
      const second = await runDerivative("demo", { ...spec, id: `${spec.id}-b` }, f.rootDir);
      assert.equal(second.reused, false);
      assert.equal(second.receipt.output.sha256, first.receipt.output.sha256, spec.id);
      assert.match(second.receipt.warnings.join("\n"), new RegExp(`registered by derivative ${spec.id}\\b`));
    }
  },
);

test("AC7 determinism and AC8 immutability", media, async (t) => {
  const f = fixture(t);
  const steps: DerivationStep[] = [
    { op: "trim", startSec: 0, durationSec: 1.5 },
    { op: "crop", x: 16, y: 0, width: 288, height: 240 },
    { op: "fps", fps: 8 },
  ];
  const a = await runDerivative("demo", f.spec("det-a", steps), f.rootDir);
  const b = await runDerivative("demo", f.spec("det-b", steps), f.rootDir);
  assert.equal(a.receipt.output.sha256, b.receipt.output.sha256);
  assert.equal(a.receipt.engine.version, b.receipt.engine.version);
  assert.match(b.receipt.warnings.join("\n"), /registered by derivative det-a/);
  for (const [id, input] of [
    ["det-png-a", { assetId: f.still.id }],
    ["det-png-b", { assetId: f.still.id }],
  ] as const)
    await runDerivative("demo", f.spec(id, [{ op: "scale", width: 32, height: 32, fit: "pad" }], input), f.rootDir);
  assert.equal(
    showDerivative("demo", "det-png-a", f.rootDir).receipt.output.sha256,
    showDerivative("demo", "det-png-b", f.rootDir).receipt.output.sha256,
  );
  // Same id and spec: the stored receipt, not a rerun.
  const again = await runDerivative("demo", f.spec("det-a", steps), f.rootDir);
  assert.equal(again.reused, true);
  assert.equal(again.sha256, a.sha256);
  assert.equal(planDerivative("demo", f.spec("det-a", steps), f.rootDir).existing, "same");
  // Changed spec, same id: FILE_EXISTS.
  await assert.rejects(
    runDerivative("demo", f.spec("det-a", [...steps, { op: "strip-audio" }]), f.rootDir),
    (error: Error & { code?: string }) => error.code === "FILE_EXISTS",
  );
  assert.equal(planDerivative("demo", f.spec("det-a", steps.slice(0, 1)), f.rootDir).existing, "conflict");
});

test("CLI prints one JSON line for plan, run and show", media, (t) => {
  const f = fixture(t);
  const specFile = path.join(f.rootDir, "spec.json");
  writeFileSync(specFile, JSON.stringify(f.spec("cli-frame", [{ op: "extract-frame", at: 1 }])));
  const cli = (...args: string[]) => {
    const run = spawnSync(
      process.execPath,
      [TSX, path.join(REPO, "scripts/refs-derive.ts"), "--project", "demo", ...args],
      {
        cwd: f.rootDir,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, AGENTBROS_NO_DOTENV: "1" },
      },
    );
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `${run.stdout}\n${run.stderr}`);
    return { status: run.status, envelope: JSON.parse(lines[0]!) };
  };
  const plan = cli("--action", "plan", "--spec", specFile);
  assert.equal(plan.envelope.ok, true, JSON.stringify(plan.envelope));
  assert.equal(plan.envelope.metadata.runnable, true);
  const run = cli("--action", "run", "--spec", specFile);
  assert.equal(run.envelope.ok, true, JSON.stringify(run.envelope));
  assert.equal(run.envelope.metadata.output.contentType, "image/png");
  const shown = cli("--action", "show", "--id", "cli-frame");
  assert.equal(shown.envelope.metadata.sha256, run.envelope.metadata.sha256);
  const missing = cli("--action", "show", "--id", "nope");
  assert.equal(missing.envelope.ok, false);
  assert.equal(missing.envelope.error, "STAGE_INCOMPLETE");
  assert.notEqual(missing.status, 0);
});
