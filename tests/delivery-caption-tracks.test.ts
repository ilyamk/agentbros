import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DeliveryRequestSchema, DeliverySnapshotSchema, type DeliveryRequest } from "../src/types/delivery";
import { adaptLegacyProject } from "../src/lib/timeline-ir/legacy";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { captionCues, subtitleText } from "../src/lib/captions/delivery";
import { generationInputHash } from "../src/lib/jobs/runner";
import { digest } from "../src/lib/jobs/model-artifacts";
import { hashFile } from "../src/lib/assets/registry";
import {
  planSubtitleTracks,
  captureSubtitleSelection,
  assertSubtitleSelection,
  publishSubtitleFiles,
} from "../src/lib/delivery/subtitle-tracks";
import { captureDeliverySnapshot, checkDelivery } from "../src/lib/delivery/service";

const rational = (num: number, den = 1) => ({ num, den });
const config = {
  name: "Caption delivery fixture",
  formats: ["landscape"],
  productName: "Local",
  colors: {},
  voiceoverEnabled: false,
  musicVolume: 0,
  scenes: [{ id: "hook", text: "Local declaration", visualType: "title", headline: "Hello", durationInFrames: 90 }],
};
const base: DeliveryRequest = {
  version: 1,
  projectId: "demo",
  timeline: true,
  formats: ["landscape"],
  variants: ["clean"],
  placements: ["youtube"],
  loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: false },
};
const selected = [
  { trackId: "captions-ru", language: "ru", filename: "russian.srt", format: "srt" as const },
  { trackId: "captions-en", language: "en", filename: "english.vtt", format: "vtt" as const },
];
const request = () => DeliveryRequestSchema.parse({ ...base, subtitleTracks: structuredClone(selected) });
function timeline() {
  const ir = adaptLegacyProject(config, "demo"),
    visual = ir.tracks.find((track) => track.kind === "visual")!.clips[0]!;
  visual.captions = [{ id: "supporting-copy", text: "Visual supporting words", start: rational(0), end: rational(30) }];
  for (const [id, text] of [
    ["captions-ru", "Привет мир."],
    ["captions-en", "Hello world."],
  ])
    ir.tracks.push({
      id,
      kind: "captions",
      clips: [
        {
          ...structuredClone(visual),
          id: `${id}-owner`,
          captions: text.split(" ").map((text, index) => ({
            id: `${id}:${index}`,
            text,
            start: rational(index * 15),
            end: rational((index + 1) * 15),
          })),
        },
      ],
    });
  return ir;
}
function fixture(t: test.TestContext, explicit = true) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "delivery-caption-tracks-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), JSON.stringify(config));
  const file = path.join(project, "pipeline/timeline-edit.json"),
    store = new TimelineEditStore(file);
  store.initialize(timeline());
  const input = explicit ? request() : DeliveryRequestSchema.parse(base);
  const captured = captureDeliverySnapshot(input, { rootDir: root });
  return { ...captured, root, project, file, snapshotFile: captured.file, store, input };
}

test("simultaneous supplied bilingual tracks export separately with exact language and order, no visual-copy flattening", () => {
  const ir = timeline(),
    files = planSubtitleTracks(ir, request());
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((file) => file.output.language),
    ["ru", "en"],
  );
  assert.equal(files[0]!.content, "1\n00:00:00,000 --> 00:00:01,000\nПривет мир.\n");
  assert.equal(files[1]!.content, "WEBVTT\n\n1-captions-en:0\n00:00:00.000 --> 00:00:01.000\nHello world.\n");
  assert.ok(files.every((file) => !file.content.includes("Visual supporting")));
  assert.throws(() => captionCues(ir), /Overlapping caption/);
});
test("separate caption-owning speaker tracks allow matching times without claiming speaker identity", () => {
  const ir = timeline();
  ir.tracks.find((track) => track.id === "captions-ru")!.kind = "voiceover";
  ir.tracks.find((track) => track.id === "captions-en")!.kind = "presenter";
  assert.equal(planSubtitleTracks(ir, request()).length, 2);
});
test("source trim and rational rate map cue timestamps exactly before subtitle rounding", () => {
  const ir = timeline(),
    track = ir.tracks.find((track) => track.id === "captions-ru")!,
    clip = track.clips[0]!;
  clip.source.start = rational(61, 2);
  clip.source.end = rational(90);
  clip.start = rational(30);
  clip.rate = rational(3, 2);
  clip.captions = [
    { id: "a", text: "Привет", start: rational(15), end: rational(45) },
    { id: "b", text: "мир.", start: rational(60), end: rational(90) },
  ];
  const file = planSubtitleTracks(ir, DeliveryRequestSchema.parse({ ...base, subtitleTracks: [selected[0]] }))[0]!;
  assert.match(file.content, /00:00:01,000 --> 00:00:02,322/);
  const cues = captionCues(ir, { trackId: track.id });
  assert.equal(cues[0]!.startMs, 1000);
  assert.equal(cues[0]!.endMs, 2322);
});
for (const id of ["unknown", "visual"])
  test(`unknown/supporting ${id} cannot be selected as a subtitle owner`, () => {
    const ir = timeline(),
      value = request();
    value.subtitleTracks![0]!.trackId = id;
    assert.throws(() => planSubtitleTracks(ir, value), /not a caption owner/);
  });
for (const kind of ["music", "sfx"] as const)
  test(`${kind} caption copies are not subtitle owners`, () => {
    const ir = timeline();
    ir.tracks.find((track) => track.id === selected[0]!.trackId)!.kind = kind;
    assert.throws(() => planSubtitleTracks(ir, request()), /not a caption owner/);
  });
test("empty retained track and invalid source project refuse, rather than silently skipping output", () => {
  const ir = timeline();
  ir.tracks.find((track) => track.id === selected[0]!.trackId)!.clips[0]!.captions = [];
  assert.throws(() => planSubtitleTracks(ir, request()), /no retained caption cues/);
  ir.projectId = "other";
  assert.throws(() => planSubtitleTracks(ir, request()), /project required/);
});
for (const filename of [
  "../escape.srt",
  "/escape.srt",
  "nested/file.srt",
  "nested\\file.srt",
  "a..b.srt",
  ".hidden.srt",
  "CON.srt",
  "lpt1.srt",
  "captions.SRT",
  "a.vtt",
  "x".repeat(101) + ".srt",
])
  test(`unsafe or mismatched filename ${filename.slice(0, 35)} rejects`, () => {
    assert.equal(
      DeliveryRequestSchema.safeParse({ ...base, subtitleTracks: [{ ...selected[0], filename }] }).success,
      false,
    );
  });
test("strict selection rejects empty/oversized/ambiguous names, pairs, IDs, language and old/new mixed contracts", () => {
  for (const subtitleTracks of [
    [],
    Array.from({ length: 17 }, (_, i) => ({ ...selected[0], filename: `f${i}.srt`, trackId: `t${i}` })),
    [selected[0], { ...selected[1], filename: "RUSSIAN.srt", format: "srt" }],
    [selected[0], { ...selected[0], filename: "other.srt" }],
    [selected[0], { ...selected[1], trackId: "CAPTIONS-RU" }],
    [{ ...selected[0], language: " ru " }],
    [{ ...selected[0], inventedTranslation: true }],
  ])
    assert.equal(DeliveryRequestSchema.safeParse({ ...base, subtitleTracks }).success, false);
  assert.equal(DeliveryRequestSchema.safeParse({ ...base, timeline: false, subtitleTracks: selected }).success, false);
  assert.equal(
    DeliveryRequestSchema.safeParse({ ...base, subtitles: ["srt"], subtitleTracks: selected }).success,
    false,
  );
  assert.equal(
    DeliveryRequestSchema.safeParse({
      ...base,
      subtitleTracks: [{ ...selected[0], filename: "same-track.vtt", format: "vtt" }, selected[0]],
    }).success,
    true,
  );
});
test("explicit snapshot binds current consumed journal, track/content/selection hashes and placements", (t) => {
  const f = fixture(t),
    bound = f.snapshot.subtitleSelection!;
  assert.equal(bound.timelineSource.sha256, hashFile(f.file));
  assert.equal(bound.journalRevision, 0);
  assert.deepEqual(
    bound.outputs.map((output) => output.filename),
    ["russian.srt", "english.vtt"],
  );
  for (const file of captureSubtitleSelection(f.root, f.input, f.snapshot.identities)!.files)
    assert.equal(file.output.sha256, digest(file.content));
  assertSubtitleSelection(bound, captureSubtitleSelection(f.root, f.input, f.snapshot.identities));
  const manifest = checkDelivery(f.input, f.snapshot, { rootDir: f.root }).manifest;
  assert.deepEqual(manifest.subtitleOutputs, bound.outputs);
  assert.deepEqual(manifest.reviewEvidence.subtitleSelection, bound);
  assert.equal(manifest.apiCalls, 0);
  assert.equal(manifest.state, "blocked");
});
test("plain old snapshot keeps exact historical hash basis and no explicit subtitle evidence", (t) => {
  const f = fixture(t, false);
  assert.equal(f.snapshot.subtitleSelection, undefined);
  assert.equal(
    f.snapshot.id,
    generationInputHash({ version: 1, projectId: "demo", identities: f.snapshot.identities }),
  );
  assert.equal(DeliverySnapshotSchema.parse(f.snapshot).id, f.snapshot.id);
});
test("legacy one-owner cue bytes and canonical captions filename remain unchanged through immutable publication", (t) => {
  const f = fixture(t, false),
    ir = timeline();
  ir.tracks = ir.tracks.filter((track) => track.id === selected[0]!.trackId);
  const content = subtitleText(captionCues(ir), "srt");
  const output = publishSubtitleFiles(path.join(f.root, "package"), [{ name: "captions.srt", content }]);
  assert.equal(path.basename(output[0]!), "captions.srt");
  assert.equal(readFileSync(output[0]!, "utf8"), "1\n00:00:00,000 --> 00:00:01,000\nПривет мир.\n");
});
test("stale source/revision, absent journal, alias and missing identity pin refuse explicit selection", (t) => {
  const f = fixture(t),
    before = readFileSync(f.file);
  writeFileSync(f.file, before.toString("utf8") + " ");
  assert.throws(() => captureSubtitleSelection(f.root, f.input, f.snapshot.identities), /current journal pins/);
  writeFileSync(f.file, before);
  const secondIdentity = structuredClone(f.snapshot.identities[0]!);
  secondIdentity.sources = secondIdentity.sources.filter((source) => source.role !== "edit");
  assert.throws(
    () => captureSubtitleSelection(f.root, f.input, [...f.snapshot.identities, secondIdentity]),
    /current journal pins/,
  );
  const identities = structuredClone(f.snapshot.identities);
  identities[0]!.editRevision = 1;
  assert.throws(() => captureSubtitleSelection(f.root, f.input, identities), /revision differs/);
  identities[0]!.sources = identities[0]!.sources.filter((source) => source.role !== "edit");
  assert.throws(() => captureSubtitleSelection(f.root, f.input, identities), /current journal pins/);
  rmSync(f.file);
  assert.throws(() => captureSubtitleSelection(f.root, f.input, f.snapshot.identities));
  const original = path.join(f.project, "pipeline/original.json");
  writeFileSync(original, before);
  symlinkSync(original, f.file);
  assert.throws(() => captureSubtitleSelection(f.root, f.input, f.snapshot.identities), /aliases/);
});
test("request language/name/order/placements and adding/removing explicit selection cannot reuse captured snapshot", (t) => {
  const f = fixture(t);
  const variants = [
    { subtitleTracks: [...selected].reverse() },
    { subtitleTracks: [{ ...selected[0], language: "de" }, selected[1]] },
    { subtitleTracks: [{ ...selected[0], filename: "different.srt" }, selected[1]] },
    { placements: ["tiktok"] },
    { subtitleTracks: undefined },
  ];
  for (const change of variants) {
    const input = DeliveryRequestSchema.parse({ ...f.input, ...change }),
      result = checkDelivery(input, f.snapshot, { rootDir: f.root });
    assert.equal(result.productionReady, false);
    assert.ok(result.blockers.some((finding) => finding.code === "SUBTITLE_SELECTION_INVALID"));
  }
  const legacy = fixture(t, false),
    result = checkDelivery(request(), legacy.snapshot, { rootDir: legacy.root });
  assert.ok(result.blockers.some((finding) => finding.code === "SUBTITLE_SELECTION_INVALID"));
});
test("immutable publication returns separate exact UTF8 files, existing conflict and declared-byte corruption refuse", (t) => {
  const f = fixture(t),
    files = captureSubtitleSelection(f.root, f.input, f.snapshot.identities)!.files,
    directory = path.join(f.root, "package");
  const outputs = publishSubtitleFiles(directory, files);
  for (const [i, file] of outputs.entries()) assert.equal(hashFile(file), files[i]!.output.sha256);
  assert.deepEqual(publishSubtitleFiles(directory, files), outputs);
  writeFileSync(outputs[0]!, "changed");
  assert.throws(() => publishSubtitleFiles(directory, files), /Immutable artifact conflict/);
  assert.throws(
    () => publishSubtitleFiles(path.join(f.root, "other-package"), [{ ...files[0]!, content: "invented text" }]),
    /differs from exact bytes/,
  );
});
test("write/readback corruption refuses before any release marker; no render or provider execution", (t) => {
  const f = fixture(t),
    files = captureSubtitleSelection(f.root, f.input, f.snapshot.identities)!.files,
    directory = path.join(f.root, "package");
  const original = fs.linkSync;
  const mock = t.mock.method(fs, "linkSync", (source: fs.PathLike, target: fs.PathLike) => {
    original(source, target);
    if (String(target).endsWith("russian.srt")) writeFileSync(target, "corrupted after immutable link");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => publishSubtitleFiles(directory, files), /readback checksum mismatch/);
    assert.equal(existsSync(path.join(directory, "release.json")), false);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
test("actual CLI changed explicit request is one nonzero JSON blocked report, language declarations remain visible", (t) => {
  const f = fixture(t),
    file = path.join(f.root, "request.json");
  f.input.subtitleTracks![0]!.language = "de";
  writeFileSync(file, JSON.stringify(f.input));
  const cli = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/delivery.ts"),
      "--request",
      file,
      "--snapshot",
      f.snapshotFile,
    ],
    {
      cwd: f.root,
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(cli.stdout);
  assert.equal(envelope.error, "VALIDATION");
  assert.ok(
    envelope.metadata.blockers.some((finding: { code: string }) => finding.code === "SUBTITLE_SELECTION_INVALID"),
  );
  const manifest = JSON.parse(readFileSync(envelope.outputs[0], "utf8"));
  assert.equal(manifest.request.subtitleTracks[0].language, "de");
  assert.equal(manifest.apiCalls, 0);
});
