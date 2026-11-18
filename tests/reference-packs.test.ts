import "./helpers/fal-no-network";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importAsset } from "../src/lib/assets/registry";
import { approveEntityVersion, saveEntityVersion } from "../src/lib/entities/service";
import {
  approvePack,
  checkPack,
  dialectWarnings,
  listPacks,
  packBoard,
  packDigest,
  packResultBoard,
  packStatus,
  preparePack,
  readPack,
  requestDigest,
  reviewPackResult,
  writePackRights,
} from "../src/lib/references/packs";
import { ReferencePackReceiptSchema } from "../src/types/references";
import { compilePack } from "../src/lib/references/compile";
import { profileByFamily } from "../src/lib/references/profiles";
import { packState as chainPackState, packStatus as chainPackStatus } from "../src/lib/references/pack-status";
import type { EntityCardInput } from "../src/types/entities";

/** RFC 0003 WP4: pack storage, check, rights, approval, request and result review (AC13). Offline, no spend. */

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;
const SEEDANCE = "bytedance/seedance-2.5/reference-to-video";
const KLING = "fal-ai/kling-video/o3/standard/reference-to-video";

function ffmpeg(...args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
const png = (file: string, colour: string, size: string) =>
  ffmpeg("-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", "-pix_fmt", "rgb24", file);

type Origin = "provider" | "manual" | "agent-harness" | "stock";
function fixture(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reference-packs-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const src = path.join(rootDir, "src");
  mkdirSync(src);
  const file = (name: string) => path.join(src, name);
  png(file("face.png"), "0x336699", "512x512");
  png(file("plate.png"), "0x996633", "640x480");
  png(file("side.png"), "0x339966", "512x640");
  png(file("back.png"), "0x663399", "480x600");
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=480x320:r=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:duration=2:sample_rate=48000",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file("clip.mp4"),
  );
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=2:sample_rate=48000",
    "-c:a",
    "pcm_s16le",
    file("voice.wav"),
  );
  const add = (name: string, origin: Origin = "provider", referenceAssetIds: string[] = []) =>
    importAsset({
      rootDir,
      projectId: "demo",
      sourceFile: file(name),
      provenance: { origin, tool: "offline-fixture", referenceAssetIds },
    }).asset;
  const assets = {
    face: add("face.png"),
    plate: add("plate.png"),
    side: add("side.png"),
    back: add("back.png"),
    clip: add("clip.mp4"),
    voice: add("voice.wav"),
  };
  return { rootDir, project, file, add, assets };
}
type Fixture = ReturnType<typeof fixture>;

const seedanceSpec = (f: Fixture, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "market-dance",
  shotId: "s03",
  endpoint: SEEDANCE,
  profileFamily: "seedance-2.5",
  attachments: [
    {
      requirementKey: "hero-identity",
      source: { assetId: f.assets.face.id },
      slot: "images",
      order: 1,
      roleSentence: 'the face and hair of Mara <script>alert("x")</script>',
    },
    {
      requirementKey: "market-plate",
      source: { assetId: f.assets.plate.id },
      slot: "images",
      order: 2,
      roleSentence: "the market at dusk, take only the place and light",
    },
    {
      requirementKey: "dance-motion",
      source: { assetId: f.assets.clip.id },
      slot: "videos",
      order: 1,
      roleSentence: "the dance movement only",
    },
    {
      requirementKey: "hero-voice",
      source: { assetId: f.assets.voice.id },
      slot: "audio",
      order: 1,
      roleSentence: "the voice timbre of Mara",
    },
  ],
  prompt: { action: "Mara dances across the market as the lamps come on.", camera: "Slow dolly left." },
  params: {},
  audioPolicy: "reference-driven",
  ...over,
});
const imageSpec = (f: Fixture, id = "stills") => ({
  ...seedanceSpec(f, { id }),
  attachments: seedanceSpec(f).attachments.slice(0, 2),
  audioPolicy: "native",
});
const reviewFor = (pack: {
  packSha256: string;
  receipt: { attachments: { requirementKey: string; media: { sha256: string } }[] };
}) => ({
  packSha256: pack.packSha256,
  reviewer: "fixture reviewer",
  evidence: "Inspected board.html and every attachment at full size.",
  markersVerified: true,
  promptReviewed: true,
  attachments: pack.receipt.attachments.map((a) => ({
    sha256: a.media.sha256,
    requirementKey: a.requirementKey,
    suitable: true,
    evidence: "Shows what its role sentence asks for.",
  })),
});
const rightsStatement = {
  status: "owned" as const,
  userStatement: "These are my own clips, use them.",
  evidence: "The user shot the clip on their own phone.",
  processingAllowed: true as const,
  commercialAllowed: true,
  placements: ["tiktok"],
  usage: { advertising: false, endorsement: false, standaloneResale: false },
  audioRights: "owned" as const,
};
/** Fixture results were not published by generate:model from the pack (WP6 outputs.json). */
const FOREIGN = { allowForeignResult: true };
function code(fn: () => unknown, expected: string, pattern?: RegExp) {
  let caught: (Error & { code?: string }) | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as Error & { code?: string };
  }
  assert.ok(caught, `expected ${expected}`);
  assert.equal(caught.code, expected, caught.message);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}
function character(f: Fixture, id: string, over: Partial<Record<string, unknown>>) {
  const card = {
    kind: "character",
    id,
    name: id,
    description: "Synthetic character fixture",
    references: [{ assetId: f.assets.face.id, role: "front" }],
    appearance: { physical: "dark hair" },
    persona: { role: "dancer" },
    createdBy: "fixture",
    ...over,
  } as EntityCardInput;
  saveEntityVersion("demo", card, { rootDir: f.rootDir });
  approveEntityVersion(
    "demo",
    "character",
    id,
    1,
    { id: "fixture", kind: "human", authorizationEvidence: "Explicit test declaration only" },
    { expectedRevision: 1, rootDir: f.rootDir },
  );
}

test(
  "prepare writes spec, board, request and receipt; the request binds the receipt hash; reuse and FILE_EXISTS",
  media,
  (t) => {
    const f = fixture(t);
    const pack = preparePack("demo", seedanceSpec(f), f.rootDir);
    assert.equal(pack.reused, false);
    for (const name of ["spec.json", "board.html", "request.json", "receipt.json", "visual-review-template.json"])
      assert.ok(existsSync(path.join(pack.directory, name)), name);
    const receipt = ReferencePackReceiptSchema.parse(
      JSON.parse(readFileSync(path.join(pack.directory, "receipt.json"), "utf8")),
    );
    assert.equal(pack.packSha256, packDigest(receipt));
    const request = JSON.parse(readFileSync(path.join(pack.directory, "request.json"), "utf8"));
    assert.deepEqual(request.context, { referencePack: { id: "market-dance", sha256: pack.packSha256 } });
    assert.equal(request.provider, "fal");
    assert.equal(receipt.requestSha256, requestDigest(request));
    // Compiled with the real profile: slot order, markers, bindings.
    assert.deepEqual(
      receipt.attachments.map((a) => [a.requirementKey, a.marker, a.pointer]),
      [
        ["hero-identity", "@Image1", "/image_urls/0"],
        ["market-plate", "@Image2", "/image_urls/1"],
        ["dance-motion", "@Video1", "/video_urls/0"],
        ["hero-voice", "@Audio1", "/audio_urls/0"],
      ],
    );
    assert.equal(request.input.image_urls[0], `asset://sha256/${f.assets.face.hash}`);
    assert.equal(request.input.prompt, receipt.compiledPrompt);
    assert.match(receipt.compiledPrompt, /@Image1 is the face and hair of Mara/);
    // Measured facts are pinned; audio has no picture.
    const voice = receipt.attachments.find((a) => a.requirementKey === "hero-voice")!.media;
    assert.equal(voice.width, undefined);
    assert.ok(voice.durationSec! > 1.9);
    const clip = receipt.attachments.find((a) => a.requirementKey === "dance-motion")!.media;
    assert.deepEqual([clip.width, clip.height, clip.fps, clip.hasAudio], [480, 320, 24, true]);
    // The board: markers, role sentences, facts, the prompt; escaped and script-free.
    const board = readFileSync(path.join(pack.directory, "board.html"), "utf8");
    for (const needle of ["@Image1", "@Video1", "@Audio1", "the market at dusk", "480×320", "Compiled prompt"])
      assert.ok(board.includes(needle), needle);
    assert.ok(!/<script/i.test(board));
    assert.ok(board.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
    assert.ok(board.includes("../../../assets/imported/"));
    // Same spec: reused, same hash. Changed spec under the same id: FILE_EXISTS.
    const again = preparePack("demo", seedanceSpec(f), f.rootDir);
    assert.equal(again.reused, true);
    assert.equal(again.packSha256, pack.packSha256);
    code(
      () => preparePack("demo", seedanceSpec(f, { prompt: { action: "Something else." } }), f.rootDir),
      "FILE_EXISTS",
    );
    assert.equal(packStatus("demo", "market-dance", f.rootDir), "prepared");
    assert.equal(packStatus("demo", "absent", f.rootDir), "missing");
    assert.deepEqual(
      listPacks("demo", f.rootDir).map((row) => [row.id, row.status]),
      [["market-dance", "prepared"]],
    );
  },
);

test(
  "prepare refuses media outside real slot limits, wrong kinds and a family that does not own the endpoint",
  media,
  (t) => {
    const f = fixture(t);
    const spec = seedanceSpec(f);
    // The clip under the image slot: kind mismatch.
    const swapped = { ...spec, attachments: [{ ...spec.attachments[0]!, source: { assetId: f.assets.clip.id } }] };
    code(() => preparePack("demo", swapped, f.rootDir), "VALIDATION", /video; the slot carries image/);
    code(
      () => preparePack("demo", { ...spec, id: "other", profileFamily: "kling-o3" }, f.rootDir),
      "VALIDATION",
      /belongs to profile seedance-2\.5, not kling-o3/,
    );
    // A 2-second clip at 10 fps is outside Seedance's 24–60 fps: the error names the fps derivative.
    ffmpeg("-f", "lavfi", "-i", "testsrc=s=480x320:r=10:d=2", "-pix_fmt", "yuv420p", f.file("slow.mp4"));
    const slow = f.add("slow.mp4");
    const slowSpec = {
      ...spec,
      id: "slow",
      attachments: spec.attachments.map((a) => (a.slot === "videos" ? { ...a, source: { assetId: slow.id } } : a)),
    };
    code(() => preparePack("demo", slowSpec, f.rootDir), "VALIDATION", /"fps" derivative/);
    assert.ok(!existsSync(path.join(f.project, "pipeline/reference-packs/slow/receipt.json")));
  },
);

test("check detects a tampered request, attachment, board and spec", media, (t) => {
  const f = fixture(t);
  const pack = preparePack("demo", imageSpec(f), f.rootDir);
  assert.equal(checkPack("demo", "stills", f.rootDir).packSha256, pack.packSha256);
  const tamper = (name: string, edit: (text: string) => string, pattern: RegExp) => {
    const file = path.join(pack.directory, name);
    const original = readFileSync(file, "utf8");
    chmodSync(file, 0o600);
    writeFileSync(file, edit(original));
    code(() => checkPack("demo", "stills", f.rootDir), "VALIDATION", pattern);
    writeFileSync(file, original);
  };
  tamper("request.json", (text) => text.replace("Mara dances", "Mara runs"), /request\.json no longer matches/);
  tamper("request.json", (text) => text.replace(pack.packSha256, "0".repeat(64)), /request\.json no longer matches/);
  tamper("board.html", (text) => text.replace("Compiled prompt", "Prompt"), /review file board\.html changed/);
  tamper("spec.json", (text) => text.replace("market at dusk", "market at noon"), /spec\.json differs/);
  assert.equal(checkPack("demo", "stills", f.rootDir).packSha256, pack.packSha256);
  const original = path.join(f.rootDir, "public", f.assets.plate.files.original);
  chmodSync(original, 0o600);
  png(original, "0x000000", "640x480");
  code(() => checkPack("demo", "stills", f.rootDir), "VALIDATION", /changed on disk/);
});

test("pack status: verify false reads receipt and approval digests only; the default re-verifies", media, (t) => {
  const f = fixture(t);
  const pack = preparePack("demo", imageSpec(f), f.rootDir);
  approvePack("demo", "stills", "yes, go", reviewFor(pack), f.rootDir);
  assert.equal(packStatus("demo", "stills", f.rootDir), "approved");
  assert.equal(packStatus("demo", "stills", f.rootDir, { verify: false }), "approved");
  const original = path.join(f.rootDir, "public", f.assets.plate.files.original);
  chmodSync(original, 0o600);
  png(original, "0x000000", "640x480");
  // Full verification (refs:pack --action check) sees the changed bytes; the cheap chain read does not re-hash.
  code(() => packStatus("demo", "stills", f.rootDir), "VALIDATION", /changed on disk/);
  assert.equal(packStatus("demo", "stills", f.rootDir, { verify: false }), "approved");
  const state = chainPackState("demo", "stills", f.rootDir);
  assert.deepEqual([state.status, state.packSha256, state.receipt?.id], ["approved", pack.packSha256, "stills"]);
  assert.equal(chainPackStatus("demo", "stills", f.rootDir), "approved");
  // A receipt the approval does not bind is prepared; invalid ids, projects and receipts read as missing.
  const receiptFile = path.join(pack.directory, "receipt.json");
  chmodSync(receiptFile, 0o600);
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  writeFileSync(receiptFile, JSON.stringify({ ...receipt, warnings: [...receipt.warnings, "edited"] }));
  assert.equal(chainPackStatus("demo", "stills", f.rootDir), "prepared");
  writeFileSync(receiptFile, "{");
  assert.equal(chainPackStatus("demo", "stills", f.rootDir), "missing");
  assert.equal(chainPackStatus("demo", "../escape", f.rootDir), "missing");
  assert.equal(chainPackStatus("no-such-project", "stills", f.rootDir), "missing");
});

test("rights are required for video and supplied originals; approval binds pack and rights hashes", media, (t) => {
  const f = fixture(t);
  // Generated images only: no rights; approval without rightsSha256.
  const stills = preparePack("demo", imageSpec(f), f.rootDir);
  const plain = checkPack("demo", "stills", f.rootDir);
  assert.equal(plain.rightsRequired, false);
  const approvedStills = approvePack("demo", "stills", "yes, go", reviewFor(stills), f.rootDir);
  assert.equal(approvedStills.approval.rightsSha256, undefined);
  assert.equal(packStatus("demo", "stills", f.rootDir), "approved");
  // Rights recorded after an approval without them would orphan the approval: refused.
  code(() => writePackRights("demo", "stills", rightsStatement, f.rootDir), "FILE_EXISTS", /already approved/);
  assert.equal(packStatus("demo", "stills", f.rootDir), "approved");

  // A video attachment needs rights before approval.
  const pack = preparePack("demo", seedanceSpec(f), f.rootDir);
  const checked = checkPack("demo", "market-dance", f.rootDir);
  assert.equal(checked.rightsRequired, true);
  assert.match(checked.rightsReasons.join(" "), /dance-motion is a video/);
  code(() => approvePack("demo", "market-dance", "yes", reviewFor(pack), f.rootDir), "STAGE_INCOMPLETE", /rights/);
  // Reference-driven audio from supplied sound cannot be muted.
  code(
    () => writePackRights("demo", "market-dance", { ...rightsStatement, audioRights: "muted" }, f.rootDir),
    "VALIDATION",
    /audio rights/,
  );
  const rights = writePackRights("demo", "market-dance", rightsStatement, f.rootDir);
  assert.equal(rights.rights.packSha256, pack.packSha256);
  assert.equal(rights.rights.assets.length, 4);
  // Same statement again: the stored record; a different one: FILE_EXISTS.
  assert.equal(
    writePackRights("demo", "market-dance", rightsStatement, f.rootDir).rights.recordedAt,
    rights.rights.recordedAt,
  );
  code(
    () => writePackRights("demo", "market-dance", { ...rightsStatement, commercialAllowed: false }, f.rootDir),
    "FILE_EXISTS",
  );
  // The review must cover every attachment in order with its exact hash, for this pack.
  const review = reviewFor(pack);
  code(
    () =>
      approvePack(
        "demo",
        "market-dance",
        "yes",
        { ...review, attachments: [...review.attachments].reverse() },
        f.rootDir,
      ),
    "VALIDATION",
    /every attachment, in the pack's order/,
  );
  code(
    () => approvePack("demo", "market-dance", "yes", { ...review, packSha256: stills.packSha256 }, f.rootDir),
    "VALIDATION",
    /another pack hash/,
  );
  code(
    () => approvePack("demo", "market-dance", "yes", { ...review, markersVerified: false }, f.rootDir),
    "VALIDATION",
    /markersVerified/,
  );
  const approved = approvePack("demo", "market-dance", "Yes, use these four.", review, f.rootDir);
  assert.equal(approved.approval.packSha256, pack.packSha256);
  assert.equal(approved.approval.rightsSha256, packDigest(rights.rights));
  assert.equal(approved.approval.userStatement, "Yes, use these four.");
  assert.equal(packStatus("demo", "market-dance", f.rootDir), "approved");
  code(() => approvePack("demo", "market-dance", "Something else", review, f.rootDir), "FILE_EXISTS");
  assert.equal(readPack("demo", "market-dance", f.rootDir).approval?.packSha256, pack.packSha256);

  // A manually supplied image (or a generated edit of one) needs rights too.
  png(f.file("supplied.png"), "0x123456", "512x512");
  png(f.file("supplied-edit.png"), "0x654321", "512x512");
  const edit = f.add("supplied-edit.png", "provider", [f.add("supplied.png", "manual").id]);
  const supplied = {
    ...imageSpec(f, "supplied"),
    attachments: [{ ...imageSpec(f).attachments[0]!, source: { assetId: edit.id } }],
  };
  preparePack("demo", supplied, f.rootDir);
  const suppliedCheck = checkPack("demo", "supplied", f.rootDir);
  assert.equal(suppliedCheck.rightsRequired, true);
  assert.match(suppliedCheck.rightsReasons.join(" "), /supplied original \(manual/);
});

test("Kling O3 element pack with the real schema; one asset may serve two slots", media, (t) => {
  const f = fixture(t);
  const spec = {
    schemaVersion: 1,
    id: "kling-hero",
    shotId: "s04",
    endpoint: KLING,
    profileFamily: "kling-o3",
    attachments: [
      {
        requirementKey: "start",
        source: { assetId: f.assets.face.id },
        slot: "start",
        order: 1,
        roleSentence: "the opening frame",
      },
      {
        requirementKey: "hero-front",
        source: { assetId: f.assets.face.id },
        slot: "elements",
        order: 1,
        roleSentence: "Mara, the dancer",
        element: { index: 1, part: "frontal" },
      },
      {
        requirementKey: "hero-side",
        source: { assetId: f.assets.side.id },
        slot: "element-references",
        order: 1,
        roleSentence: "Mara from the side",
        element: { index: 1, part: "reference" },
      },
      {
        requirementKey: "hero-back",
        source: { assetId: f.assets.back.id },
        slot: "element-references",
        order: 2,
        roleSentence: "Mara from behind",
        element: { index: 1, part: "reference" },
      },
      {
        requirementKey: "plate",
        source: { assetId: f.assets.plate.id },
        slot: "images",
        order: 1,
        roleSentence: "the market at dusk",
      },
    ],
    prompt: { action: "Mara walks through the market." },
    params: { duration: "5" },
    audioPolicy: "native",
  };
  const pack = preparePack("demo", spec, f.rootDir);
  const input = pack.request.input as {
    elements: Record<string, unknown>[];
    image_urls: string[];
    start_image_url: string;
  };
  const face = `asset://sha256/${f.assets.face.hash}`;
  assert.equal(input.start_image_url, face);
  assert.deepEqual(input.elements, [
    {
      frontal_image_url: face,
      reference_image_urls: [`asset://sha256/${f.assets.side.hash}`, `asset://sha256/${f.assets.back.hash}`],
    },
  ]);
  // start_image_url is positional: no marker, its role sentence reads as prose.
  assert.deepEqual(Object.keys(pack.receipt.markerMap).sort(), ["@Element1", "@Image1"]);
  assert.match(pack.receipt.compiledPrompt, /The start image is the opening frame\./);
  assert.match(pack.receipt.compiledPrompt, /@Element1 is Mara, the dancer\./);
  // The board names a positional attachment by its bound field and asks for every binding to be checked.
  const board = readFileSync(path.join(pack.directory, "board.html"), "utf8");
  assert.match(board, /<div class="marker">start_image_url — bound by position<\/div>/);
  assert.doesNotMatch(board, /\(no marker\)/);
  assert.match(board, /Check every marker and every positional binding/);
  // The same asset twice in one slot stays refused.
  const twice = {
    ...spec,
    id: "kling-twice",
    attachments: [
      ...spec.attachments,
      {
        requirementKey: "plate-again",
        source: { assetId: f.assets.plate.id },
        slot: "images",
        order: 2,
        roleSentence: "again",
      },
    ],
  };
  code(() => preparePack("demo", twice, f.rootDir), "VALIDATION", /attached twice in slot images/);
});

test(
  "consent: a real face on a realFaces-rejected profile is refused, through derivatives too; voice consent",
  media,
  (t) => {
    const f = fixture(t);
    character(f, "mara", {
      likenessConsent: { status: "documented", evidence: "Signed release", scope: "this film", subject: "Mara" },
      voice: {
        description: "warm alto",
        consent: { status: "unknown" },
        sampleAssetIds: [f.assets.voice.id],
      },
    });
    code(() => preparePack("demo", imageSpec(f), f.rootDir), "VALIDATION", /seedance-2\.5 rejects real faces/);
    // A generated edit of the face is still Mara.
    png(f.file("face-edit.png"), "0x224466", "512x512");
    const edit = f.add("face-edit.png", "provider", [f.assets.face.id]);
    code(
      () =>
        preparePack(
          "demo",
          { ...imageSpec(f, "edit"), attachments: [{ ...imageSpec(f).attachments[0]!, source: { assetId: edit.id } }] },
          f.rootDir,
        ),
      "VALIDATION",
      /rejects real faces/,
    );
    assert.ok(!existsSync(path.join(f.project, "pipeline/reference-packs/stills")));
    // A fictional character passes the face check; its voice sample still needs voice consent.
    character(f, "nova", {
      references: [{ assetId: f.assets.side.id, role: "front" }],
      likenessConsent: { status: "not-applicable" },
      voice: { description: "synthetic", consent: { status: "unknown" }, sampleAssetIds: [f.assets.voice.id] },
    });
    const nova = {
      ...seedanceSpec(f, { id: "nova" }),
      attachments: [
        { ...seedanceSpec(f).attachments[0]!, source: { assetId: f.assets.side.id } },
        seedanceSpec(f).attachments[3]!,
      ],
    };
    code(() => preparePack("demo", nova, f.rootDir), "STAGE_INCOMPLETE", /voice consent is unknown/);
    const imageOnly = { ...nova, id: "nova-still", attachments: nova.attachments.slice(0, 1), audioPolicy: "native" };
    const pack = preparePack("demo", imageOnly, f.rootDir);
    assert.ok(pack.receipt.compiledPrompt.includes("@Image1"));
  },
);

test(
  "result-board and review-result: bound to pack and output bytes, failed-dimension invariant, immutable",
  media,
  (t) => {
    const f = fixture(t);
    const spec = { ...imageSpec(f, "with-subjects"), prompt: { action: "Mara waits.", otherSubjects: ["the vendor"] } };
    const pack = preparePack("demo", spec, f.rootDir);
    const out = path.join(f.rootDir, "out/demo");
    mkdirSync(out, { recursive: true });
    const result = path.join(out, "result.mp4");
    ffmpeg("-f", "lavfi", "-i", "testsrc=s=320x240:r=24:d=1", "-pix_fmt", "yuv420p", result);
    // Outside the project and its out/ folder: refused.
    const stray = path.join(f.rootDir, "stray.mp4");
    writeFileSync(stray, readFileSync(result));
    code(() => packResultBoard("demo", "with-subjects", stray, f.rootDir), "INVALID_INPUT");
    const board = packResultBoard("demo", "with-subjects", result, f.rootDir);
    assert.equal(board.frames.length, 3);
    assert.ok(board.frames.every((frame) => existsSync(frame)));
    const html = readFileSync(board.board, "utf8");
    assert.ok(html.includes("@Image1") && html.includes("result-1.png") && !/<script/i.test(html));
    assert.equal(board.result.packSha256, pack.packSha256);
    const review = {
      schemaVersion: 1,
      packSha256: pack.packSha256,
      outputSha256: board.outputSha256,
      reviewer: "fixture reviewer",
      evidence: "Watched the whole result next to the attachments.",
      identity: "pass",
      wardrobe: "not-applicable",
      preserved: "pass",
      otherSubjects: "pass",
      motion: "pass",
      naturalness: "pass",
      promptFit: "pass",
      temporalConsistency: "pass",
      audio: "pass",
      verdict: "pass",
    };
    code(
      () => reviewPackResult("demo", "with-subjects", { ...review, motion: "fail" }, f.rootDir, FOREIGN),
      "VALIDATION",
      /failed dimension/,
    );
    code(
      () =>
        reviewPackResult("demo", "with-subjects", { ...review, otherSubjects: "not-applicable" }, f.rootDir, FOREIGN),
      "VALIDATION",
      /other subjects/,
    );
    code(
      () => reviewPackResult("demo", "with-subjects", { ...review, audio: "replace-in-edit" }, f.rootDir, FOREIGN),
      "VALIDATION",
      /audio policy/,
    );
    code(
      () => reviewPackResult("demo", "with-subjects", { ...review, outputSha256: "a".repeat(64) }, f.rootDir, FOREIGN),
      "STAGE_INCOMPLETE",
    );
    const reshoot = reviewPackResult(
      "demo",
      "with-subjects",
      { ...review, motion: "fail", verdict: "reshoot" },
      f.rootDir,
      FOREIGN,
    );
    assert.match(reshoot.nextAction, /Ask the user/);
    assert.ok(reshoot.file.endsWith(`results/${board.outputSha256}/review.json`));
    code(() => reviewPackResult("demo", "with-subjects", review, f.rootDir, FOREIGN), "FILE_EXISTS");
    // Changed result bytes are refused.
    chmodSync(result, 0o600);
    ffmpeg("-f", "lavfi", "-i", "testsrc=s=320x240:r=24:d=1:decimals=1", "-pix_fmt", "yuv420p", result);
    const second = { ...review, outputSha256: board.outputSha256 };
    rmSync(reshoot.file);
    code(() => reviewPackResult("demo", "with-subjects", second, f.rootDir, FOREIGN), "VALIDATION", /bytes changed/);
  },
);

test("CLI prints one JSON line for prepare, check, board, request and errors", media, (t) => {
  const f = fixture(t);
  const specFile = path.join(f.rootDir, "spec.json");
  writeFileSync(specFile, JSON.stringify(imageSpec(f)));
  const cli = (...args: string[]) => {
    const run = spawnSync(
      process.execPath,
      [TSX, path.join(REPO, "scripts/refs-pack.ts"), "--project", "demo", ...args],
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
  const prepared = cli("--action", "prepare", "--spec", specFile);
  assert.equal(prepared.envelope.ok, true, JSON.stringify(prepared.envelope));
  const sha = prepared.envelope.metadata.packSha256;
  const checked = cli("--action", "check", "--id", "stills");
  assert.equal(checked.envelope.metadata.packSha256, sha);
  assert.equal(cli("--action", "board", "--id", "stills").envelope.metadata.markerMap["@Image1"], f.assets.face.id);
  const request = cli("--action", "request", "--id", "stills");
  assert.equal(request.envelope.metadata.approved, false);
  assert.equal(request.envelope.metadata.request.context.referencePack.sha256, sha);
  const missing = cli("--action", "check", "--id", "nope");
  assert.equal(missing.envelope.ok, false);
  assert.equal(missing.envelope.error, "STAGE_INCOMPLETE");
  assert.notEqual(missing.status, 0);
  const agentWords = cli(
    "--action",
    "approve",
    "--id",
    "stills",
    "--review",
    specFile,
    "--answer",
    "the user approved",
  );
  assert.equal(agentWords.envelope.error, "INVALID_INPUT");
});

test("a marker-less pack (kling-v2.6 motion control) carries no unverified-dialect warning; its board names fields", () => {
  const profile = profileByFamily("kling-v2.6-motion-control")!;
  assert.equal(profile.dialect.evidence.tier, "unverified");
  const face = `sha256:${"1".repeat(64)}`,
    clip = `sha256:${"2".repeat(64)}`;
  const compiled = compilePack({
    spec: {
      schemaVersion: 1,
      id: "motion-copy",
      shotId: "s05",
      endpoint: "fal-ai/kling-video/v2.6/standard/motion-control",
      profileFamily: profile.family,
      attachments: [
        {
          requirementKey: "dancer",
          source: { assetId: face },
          slot: "character",
          order: 1,
          roleSentence: "the dancer",
        },
        { requirementKey: "moves", source: { assetId: clip }, slot: "motion", order: 1, roleSentence: "the moves" },
      ],
      prompt: { action: "The dancer performs the moves in a sunlit studio." },
      audioPolicy: "mute",
    },
    profile,
    media: {
      [face]: { bytes: 1000, contentType: "image/png", width: 512, height: 512 },
      [clip]: { bytes: 9000, contentType: "video/mp4", width: 480, height: 360, durationSec: 3, fps: 24 },
    },
  });
  assert.deepEqual(compiled.markerMap, {});
  assert.deepEqual(dialectWarnings(profile, compiled.markerMap), []);
  // The same unverified tier on a dialect the prompt does use still warns.
  assert.match(dialectWarnings(profile, { "@Image1": face }).join(" "), /marker dialect is unverified/);
  const pin = (assetId: string, contentType: string) => ({
    assetId,
    sha256: assetId.slice(7),
    original: `projects/demo/assets/${assetId.slice(7, 15)}`,
    bytes: 1000,
    contentType,
    hasAudio: false,
  });
  const board = packBoard({
    id: "motion-copy",
    shotId: "s05",
    endpoint: "fal-ai/kling-video/v2.6/standard/motion-control",
    provider: "fal",
    family: profile.family,
    audioPolicy: "mute",
    attachments: compiled.attachments.map((a, i) => ({
      requirementKey: a.requirementKey,
      marker: a.marker,
      pointer: a.pointer,
      media: i === 0 ? pin(face, "image/png") : pin(clip, "video/mp4"),
      provenanceSha256: "0".repeat(64),
      slot: i === 0 ? "character" : "motion",
      order: 1,
      roleSentence: i === 0 ? "the dancer" : "the moves",
    })),
    compiledPrompt: compiled.compiledPrompt,
    input: compiled.input,
    warnings: [],
    boardDir: "/board",
    publicDir: "/public",
  });
  assert.match(board, /image_url — bound by position/);
  assert.match(board, /video_url — bound by position/);
  assert.doesNotMatch(board, /\(no marker\)/);
});
