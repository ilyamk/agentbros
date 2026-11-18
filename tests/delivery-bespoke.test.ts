import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureDeliverySnapshot, checkDelivery } from "../src/lib/delivery/service";
import {
  BESPOKE_VARIANT,
  bespokeOutput,
  bespokeLocalAssets,
  captureBespokeIdentity,
  DEFAULT_FILM_ENTRY,
  isBespokeDelivery,
} from "../src/lib/delivery/bespoke";
import { publishRenderReceipt } from "../src/lib/delivery/render-receipt";
import { LocalResultReceiptSchema } from "../src/types/local-capabilities";
import { atomicJson, fileHash } from "../src/lib/apple/runtime";
import { importAsset } from "../src/lib/assets/registry";
import { hashFile } from "../src/lib/assets/registry";
import { DEFAULT_ENTRY } from "../src/lib/vision/composition";
import { planProjectRender } from "../src/lib/render-plan";
import type { DeliveryRequest } from "../src/types/delivery";
import { VorkReceiptSchema } from "../src/types/vork";

// A bespoke film (film chain, film:render) has no project.json: delivery takes it by its own route (docs/delivery.md, "Bespoke films").

const work = mkdtempSync(path.join(tmpdir(), "delivery-bespoke-media-"));
test.after(() => rmSync(work, { recursive: true, force: true }));
function film(size = "1920x1080", seconds = 1) {
  const file = path.join(work, `film-${size}-${seconds}.mp4`);
  if (!existsSync(file)) {
    const run = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=blue:s=${size}:r=30:d=${seconds}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${seconds}`,
        "-af",
        "loudnorm=I=-16:TP=-2:LRA=7",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        String(seconds),
        "-y",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
  }
  return file;
}

function bespokeProject(t: test.TestContext, withAsset = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "delivery-bespoke-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/film");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(project, "pipeline", name), JSON.stringify(value));
  write("brief.json", { renderMode: "bespoke", format: "landscape" });
  write("motion-plan.json", { fps: 30, shots: [{ id: "s1", startFrame: 0, durationFrames: 30 }] });
  write("build.json", { composition: "Film-demo" });
  // Written after the render: never part of the snapshot.
  write("film-render.json", { note: "film:render receipt" });
  if (withAsset) {
    mkdirSync(path.join(project, "assets"));
    writeFileSync(path.join(project, "assets/still.png"), "owned still");
  }
  // What film:render does: render out/<id>/film.mp4, then publish delivery's receipt.
  const output = bespokeOutput(root, "film");
  mkdirSync(path.dirname(output), { recursive: true });
  spawnSync("cp", [film(), output]);
  const identity = captureBespokeIdentity("film", "landscape", { rootDir: root });
  publishRenderReceipt(output, identity, identity, root);
  const request: DeliveryRequest = {
    version: 1,
    projectId: "film",
    formats: ["landscape"],
    variants: [BESPOKE_VARIANT],
    placements: ["youtube"],
    approvalMode: "manual",
    loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
  } as DeliveryRequest;
  return { root, project, output, request, write };
}

function approve(
  f: ReturnType<typeof bespokeProject>,
  snapshot: ReturnType<typeof captureDeliverySnapshot>["snapshot"],
) {
  const human = {
    reviewedBy: "Fixture reviewer",
    reviewedAt: new Date().toISOString(),
    evidence: "Explicit local test declaration",
  };
  f.request.manualApproval = {
    ...human,
    storyHash: snapshot.identities[0]!.storyHash,
    sourceSnapshotHash: snapshot.id,
  };
  f.request.visualReview = {
    ...human,
    sourceSnapshotHash: snapshot.id,
    outputHashes: [hashFile(f.output)],
    approved: true,
  };
}

const codes = (r: ReturnType<typeof checkDelivery>) => r.blockers.map((finding) => finding.code);

test("delivery and the bespoke route agree on the default entry", () =>
  assert.equal(DEFAULT_FILM_ENTRY, DEFAULT_ENTRY));

test("a bespoke film rendered with its receipt passes snapshot and check and is production-ready", (t) => {
  const f = bespokeProject(t);
  assert.equal(isBespokeDelivery(f.root, "film"), true);
  const { snapshot } = captureDeliverySnapshot(f.request, { rootDir: f.root });
  const identity = snapshot.identities[0]!;
  assert.equal(identity.compositionId, "Film-demo");
  assert.equal(identity.durationInFrames, 30);
  assert.ok(
    identity.sources.some(
      (source) => source.path === "public/projects/film/pipeline/motion-plan.json" && source.role === "creative",
    ),
  );
  assert.ok(
    !identity.sources.some((source) => source.path.endsWith("film-render.json")),
    "a file written after the render is not a source",
  );

  const unapproved = checkDelivery(f.request, snapshot, { rootDir: f.root });
  assert.ok(
    codes(unapproved).includes("CREATIVE_APPROVAL_REQUIRED"),
    "chain approvals are not read: manualApproval is required",
  );

  approve(f, snapshot);
  const result = checkDelivery(f.request, snapshot, { rootDir: f.root });
  assert.equal(result.productionReady, true, JSON.stringify(result.blockers));
  assert.ok(
    result.outputs.some((file) => file.endsWith("release.json")),
    JSON.stringify(result.outputs),
  );
});

test("a bespoke film's own media are sources and need rights evidence like any project's", (t) => {
  const f = bespokeProject(t, true);
  const { snapshot } = captureDeliverySnapshot(f.request, { rootDir: f.root });
  assert.ok(
    snapshot.identities[0]!.sources.some(
      (source) => source.path === "public/projects/film/assets/still.png" && source.role === "asset",
    ),
  );
  approve(f, snapshot);
  assert.deepEqual(codes(checkDelivery(f.request, snapshot, { rootDir: f.root })), ["RIGHTS_UNCONFIRMED"]);
});

test("a bespoke film edited after its render needs a new render; wrong request shapes are refused", (t) => {
  const f = bespokeProject(t);
  const { snapshot } = captureDeliverySnapshot(f.request, { rootDir: f.root });
  approve(f, snapshot);
  f.write("motion-plan.json", { fps: 30, shots: [{ id: "s1", startFrame: 0, durationFrames: 30, note: "edited" }] });
  const stale = checkDelivery(f.request, snapshot, { rootDir: f.root });
  assert.equal(stale.productionReady, false);
  assert.ok(codes(stale).includes("SOURCE_CHANGED"), JSON.stringify(codes(stale)));

  assert.throws(
    () => captureDeliverySnapshot({ ...f.request, variants: ["clean", "captioned"] }, { rootDir: f.root }),
    /bespoke film.*no clean variant/,
  );
  assert.throws(
    () => captureDeliverySnapshot({ ...f.request, formats: ["vertical"] }, { rootDir: f.root }),
    /formats \["landscape"\]/,
  );
});

test("a missing film names film:render; the template render plan points a bespoke project to its route", (t) => {
  const f = bespokeProject(t);
  const { snapshot } = captureDeliverySnapshot(f.request, { rootDir: f.root });
  rmSync(f.output);
  const missing = checkDelivery(f.request, snapshot, { rootDir: f.root });
  assert.match(
    missing.blockers.find((finding) => finding.code === "RENDER_MISSING")!.message,
    /film:render --project film/,
  );
  assert.throws(() => planProjectRender("film", "landscape", f.root), /film:render/);
});

test("unused native draft is retained without blocking bespoke delivery; selected draft is refused", (t) => {
  const f = bespokeProject(t);
  const source = path.join(f.root, "voice.json.assets/generation/voice.mp3");
  mkdirSync(path.dirname(source), { recursive: true });
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.1", source]).status, 0);
  const value = LocalResultReceiptSchema.parse({
    version: 1,
    task: "speech.synthesise",
    backend: "apple-tts",
    operationId: "a".repeat(64),
    createdAt: new Date().toISOString(),
    identity: "b".repeat(64),
    systemModelsHashPinned: false,
    requestHash: "c".repeat(64),
    inputs: [],
    outputs: [{ file: source, sha256: fileHash(source) }],
    purpose: "draft",
    checks: [],
    warnings: [],
  });
  atomicJson(path.join(path.dirname(source), "receipt.json"), value);
  const asset = importAsset({
    rootDir: f.root,
    projectId: "film",
    sourceFile: source,
    provenance: { origin: "manual" },
  }).asset;
  assert.throws(() => captureBespokeIdentity("film", "landscape", { rootDir: f.root }), /localAssets/u);
  const build = path.join(f.project, "pipeline/build.json");
  const select = (localAssets: string[]) => {
    writeFileSync(build, JSON.stringify({ composition: "Film-demo", localAssets }));
    const identity = captureBespokeIdentity("film", "landscape", { rootDir: f.root });
    publishRenderReceipt(bespokeOutput(f.root, "film"), identity, identity, f.root);
    return captureDeliverySnapshot(f.request, { rootDir: f.root }).snapshot;
  };
  const unused = select([]);
  approve(f, unused);
  assert.throws(
    () => captureBespokeIdentity("film", "landscape", { rootDir: f.root, props: { audio: asset.files.original } }),
    /localAssets/u,
  );
  assert.ok(!codes(checkDelivery(f.request, unused, { rootDir: f.root })).includes("LOCAL_IMPORTED_DRAFT"));
  const used = select([asset.files.original]);
  approve(f, used);
  assert.ok(codes(checkDelivery(f.request, used, { rootDir: f.root })).includes("LOCAL_IMPORTED_DRAFT"));
});

test("Vork imports and direct frame patterns require declarations and retain the draft barrier", (t) => {
  const f = bespokeProject(t),
    directory = path.join(f.project, "assets/vork"),
    frames = path.join(directory, "frames");
  mkdirSync(frames, { recursive: true });
  const generated = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=16x16:r=30:d=0.1",
    "-frames:v",
    "2",
    "-start_number",
    "0",
    path.join(frames, "%06d.png"),
  ]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const scene = path.join(directory, "scene.json");
  writeFileSync(scene, "{}");
  const pin = (file: string) => ({ file: path.relative(f.root, file), sha256: hashFile(file) });
  const receipt = VorkReceiptSchema.parse({
    schemaVersion: 1,
    engine: "vork",
    version: "0.5.1",
    purpose: "draft",
    operation: "render",
    createdAt: new Date().toISOString(),
    root: ".",
    tool: pin(scene),
    runtime: [pin(scene)],
    inputs: [pin(scene)],
    outputs: [pin(path.join(frames, "000000.png")), pin(path.join(frames, "000001.png"))],
    settings: { profile: "std/draft", seed: 42, fps: 30, resolution: [16, 16], frames: [0, 1], samples: 4 },
    warnings: [],
    elapsedMs: 1,
    metadata: "fixture",
  });
  writeFileSync(path.join(directory, "vork-receipt.json"), JSON.stringify(receipt));
  const asset = importAsset({
    rootDir: f.root,
    projectId: "film",
    sourceFile: path.join(frames, "000000.png"),
    provenance: { origin: "manual" },
  }).asset;
  assert.throws(() => captureBespokeIdentity("film", "landscape", { rootDir: f.root }), /localAssets/);
  const select = (localAssets: string[]) => {
    f.write("build.json", { composition: "Film-demo", localAssets });
    const identity = captureBespokeIdentity("film", "landscape", { rootDir: f.root });
    publishRenderReceipt(f.output, identity, identity, f.root);
    const { snapshot } = captureDeliverySnapshot(f.request, { rootDir: f.root });
    approve(f, snapshot);
    return snapshot;
  };
  assert.ok(!codes(checkDelivery(f.request, select([]), { rootDir: f.root })).includes("LOCAL_IMPORTED_DRAFT"));
  assert.ok(
    codes(checkDelivery(f.request, select([asset.files.original]), { rootDir: f.root })).includes(
      "LOCAL_IMPORTED_DRAFT",
    ),
  );
  const pattern = "projects/film/assets/vork/frames/######.png";
  const direct = select([pattern]);
  assert.equal(bespokeLocalAssets(f.root, "film").length, 2);
  assert.ok(codes(checkDelivery(f.request, direct, { rootDir: f.root })).includes("LOCAL_IMPORTED_DRAFT"));
  const extra = path.join(frames, "000002.png");
  writeFileSync(extra, "unbound frame");
  assert.throws(() => bespokeLocalAssets(f.root, "film"), /Every frame/);
  rmSync(extra);
  writeFileSync(path.join(frames, "000001.png"), "altered");
  assert.throws(() => captureBespokeIdentity("film", "landscape", { rootDir: f.root }), /binding mismatch/);
});
