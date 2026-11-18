import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { planCueSounds, type LibrarySound, type PackSound } from "../src/lib/audio/cue-sounds";
import {
  buildSfxMeasureIndex,
  constraintFit,
  librarySounds,
  measureFiles,
  parseConstraintText,
  type SfxMeasure,
} from "../src/lib/audio/sfx-index";
import { kindTags, relativeTags, sfxTagsFromScores, SFX_LABELS } from "../src/lib/audio/sfx-clap";

const measure = (over: Partial<SfxMeasure>): SfxMeasure => ({
  durationSec: 1,
  onsetSec: 0,
  attackSec: 0.005,
  peakSec: 0.01,
  peakFraction: 0.01,
  tailSec: 0.9,
  activeSec: 1,
  integratedLufs: -20,
  samplePeakDb: -1,
  crestDb: 15,
  centroidHz: 2000,
  centroidTrend: 0,
  centroidTrajectory: "flat",
  bands: { low: 0.2, mid: 0.6, high: 0.2 },
  transientSharpness: 0.8,
  nearPeakShare: 0.1,
  onsetCount: 1,
  dynamics: "impulse",
  ...over,
});

test("index build: provenance from the kind manifest, hashing, reuse of unchanged entries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sfx-index-test-"));
  const dir = path.join(root, "public", "shared", "sfx");
  mkdirSync(path.join(dir, "whoosh"), { recursive: true });
  writeFileSync(path.join(dir, "whoosh", "a.wav"), "fake-a");
  writeFileSync(path.join(dir, "loose.mp3"), "fake-b");
  writeFileSync(
    path.join(dir, "whoosh", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "whoosh",
      entries: [{ file: "a.wav", source: "freesound", sourceUrl: "https://freesound.org/s/1/", licence: "CC0-1.0" }],
    }),
  );
  let calls = 0;
  const fake = (files: string[]) => {
    calls += files.length;
    return Object.fromEntries(
      files.map((file) => [
        file,
        file.endsWith("loose.mp3") ? { error: "decode failed" } : measure({ dynamics: "sweep", peakFraction: 0.5 }),
      ]),
    );
  };
  const output = path.join(dir, "sfx-index.json");
  const first = buildSfxMeasureIndex({
    dir,
    output,
    publicDir: path.join(root, "public"),
    measure: fake,
    now: "2026-01-01T00:00:00Z",
  });
  assert.equal(first.index.entries.length, 2);
  const whoosh = first.index.entries.find((entry) => entry.file === "shared/sfx/whoosh/a.wav")!;
  assert.equal(whoosh.kind, "whoosh");
  assert.equal(whoosh.licence, "CC0-1.0");
  assert.equal(whoosh.measured?.dynamics, "sweep");
  assert.equal(first.errors.length, 1);
  const second = buildSfxMeasureIndex({ dir, output, publicDir: path.join(root, "public"), measure: fake });
  assert.equal(second.reused, 1, "the measured file is reused; the failed one is measured again");
  assert.equal(calls, 3);
  assert.equal(librarySounds(second.index).length, 1);
});

test("constraint fit prefers the measured shape asked for", () => {
  const early = constraintFit(measure({ peakFraction: 0.2, activeSec: 0.5 }), { peakFraction: 0.6, durationSec: 0.5 });
  const right = constraintFit(measure({ peakFraction: 0.6, activeSec: 0.5 }), { peakFraction: 0.6, durationSec: 0.5 });
  assert.ok(right.fit > early.fit);
  assert.ok(right.why.some((reason) => /peak at 60%/.test(reason)));
  assert.deepEqual(parseConstraintText("short airy whoosh, peak at 60%, soft tail, 0.5 s"), {
    peakFraction: 0.6,
    durationSec: 0.5,
    softness: "soft",
    kind: "whoosh",
  });
});

test("CLAP tag helpers: softmax over kinds, z-scores over descriptors", () => {
  const scores = SFX_LABELS.map((_, index) => (index === 2 ? 0.4 : 0.1));
  const tags = sfxTagsFromScores(scores);
  assert.equal(tags.kinds[0]!.tag, "whoosh");
  assert.ok(tags.kinds[0]!.score > 0.9);
  assert.equal(kindTags([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]).length, 9);
  assert.equal(relativeTags(["a", "b", "c"], [0.1, 0.3, 0.2], 1)[0]!.tag, "b");
});

const pack: PackSound[] = [
  { kind: "hit", file: "hit.wav", alignSec: 0, durationSec: 1.8 },
  { kind: "riser", file: "riser.wav", alignSec: 2, durationSec: 2, lengthFrames: 60 },
  { kind: "whoosh", file: "whoosh.wav", alignSec: 0.4, durationSec: 0.7 },
  { kind: "tick", file: "tick.wav", alignSec: 0, durationSec: 0.05 },
];
const library: LibrarySound[] = [
  {
    kind: "riser",
    file: "shared/sfx/riser/r1.mp3",
    durationSec: 1.1,
    onsetSec: 0,
    peakSec: 1,
    tailSec: 0.1,
    dynamics: "swell",
    integratedLufs: -20,
  },
  {
    kind: "riser",
    file: "shared/sfx/riser/r4.mp3",
    durationSec: 4.1,
    onsetSec: 0,
    peakSec: 4,
    tailSec: 0.1,
    dynamics: "swell",
    integratedLufs: -20,
  },
  {
    kind: "whoosh",
    file: "shared/sfx/whoosh/w1.mp3",
    durationSec: 0.8,
    onsetSec: 0,
    peakSec: 0.48,
    tailSec: 0.3,
    dynamics: "sweep",
    integratedLufs: -14,
  },
  {
    kind: "whoosh",
    file: "shared/sfx/whoosh/w2.mp3",
    durationSec: 0.6,
    onsetSec: 0,
    peakSec: 0.3,
    tailSec: 0.3,
    dynamics: "sweep",
    integratedLufs: -20,
  },
  {
    kind: "impact",
    file: "shared/sfx/impact/short.mp3",
    durationSec: 0.3,
    onsetSec: 0.02,
    peakSec: 0.03,
    tailSec: 0.25,
    dynamics: "impulse",
    integratedLufs: -20,
  },
  {
    kind: "impact",
    file: "shared/sfx/impact/boom.mp3",
    durationSec: 3,
    onsetSec: 0.01,
    peakSec: 0.05,
    tailSec: 2.9,
    dynamics: "impulse",
    integratedLufs: -20,
  },
];
const options = { fps: 30, durationInFrames: 900, pack, library };

test("library: riser length fits the run-up, its peak lands on the hit", () => {
  const short = planCueSounds(
    [
      {
        blockId: "a",
        startFrame: 0,
        cues: [
          { frame: 270, kind: "land", sfx: "tick" },
          { frame: 300, kind: "hit", sfx: "riser", weight: "hero" },
        ],
      },
    ],
    options,
  );
  const riser = short.events.find((event) => event.sfx === "riser")!;
  assert.equal(riser.file, "shared/sfx/riser/r1.mp3", "1 s run-up takes the 1 s riser");
  assert.equal(riser.startFrame, 270);
  assert.equal(riser.origin, "library");
  const long = planCueSounds(
    [
      {
        blockId: "a",
        startFrame: 0,
        cues: [
          { frame: 150, kind: "land", sfx: "tick" },
          { frame: 300, kind: "hit", sfx: "riser", weight: "hero" },
        ],
      },
    ],
    options,
  );
  assert.equal(long.events.find((event) => event.sfx === "riser")!.file, "shared/sfx/riser/r4.mp3");
  assert.equal(long.events.find((event) => event.sfx === "riser")!.startFrame, 300 - 120);
});

test("library: impact tail fits before the next cue, whoosh peak on the cue, loudness trimmed", () => {
  const { events } = planCueSounds(
    [
      {
        blockId: "a",
        startFrame: 0,
        cues: [
          { frame: 100, kind: "land", sfx: "impact", weight: "hero" },
          { frame: 112, kind: "peak", sfx: "whoosh" },
          { frame: 700, kind: "land", sfx: "impact", weight: "hero" },
        ],
      },
    ],
    options,
  );
  const [first, whoosh, second] = [...events].sort((a, b) => a.cueFrame - b.cueFrame);
  assert.equal(first!.file, "shared/sfx/impact/short.mp3", "0.4 s to the next cue: the short hit");
  assert.equal(second!.file, "shared/sfx/impact/boom.mp3", "room for the boom's tail");
  assert.equal(whoosh!.startFrame, 112 - Math.round(whoosh!.alignSec! * 30));
  if (whoosh!.file.endsWith("w1.mp3")) assert.ok(whoosh!.gain < 0.14, "a louder file plays quieter");
});

test("library choice is seeded, deterministic, never the same file twice in a row, and falls back to synth", () => {
  const blocks = [
    {
      blockId: "a",
      startFrame: 0,
      cues: [60, 120, 180, 240].map((frame) => ({ frame, kind: "peak" as const, sfx: "whoosh" as const })),
    },
  ];
  const one = planCueSounds(blocks, options);
  assert.deepEqual(planCueSounds(blocks, options).events, one.events);
  const files = one.events.map((event) => event.file);
  for (let index = 1; index < files.length; index += 1) assert.notEqual(files[index], files[index - 1]);
  const mixed = planCueSounds(
    [
      {
        blockId: "a",
        startFrame: 0,
        cues: [
          { frame: 60, kind: "peak", sfx: "whoosh", weight: "hero" },
          { frame: 180, kind: "peak", sfx: "whoosh", weight: "hero" },
          { frame: 120, kind: "peak", sfx: "whoosh" },
        ],
      },
    ],
    {
      ...options,
      library: [
        ...library,
        {
          kind: "whoosh",
          file: "shared/sfx/whoosh/w3.mp3",
          durationSec: 0.7,
          onsetSec: 0,
          peakSec: 0.35,
          tailSec: 0.3,
          dynamics: "sweep",
          integratedLufs: -20,
        },
      ],
    },
  );
  const order = [...mixed.events].sort((a, b) => a.cueFrame - b.cueFrame).map((event) => event.file);
  assert.equal(new Set(order).size, 3, "the support cue between two heroes repeats neither");
  const fallback = planCueSounds(
    [{ blockId: "a", startFrame: 0, cues: [{ frame: 30, kind: "click", sfx: "tick" }] }],
    options,
  );
  assert.equal(fallback.events[0]!.origin, "synth");
  assert.equal(fallback.events[0]!.file, "shared/sfx/synth/tick.wav");
});

test(
  "measurement worker reads a synth click as a short impulse",
  { skip: !process.env.RUN_SFX_INDEX_TESTS && "set RUN_SFX_INDEX_TESTS=1 (runs the uv worker)" },
  () => {
    const result = measureFiles([path.resolve("public/shared/sfx/synth/click.wav")]);
    const entry = Object.values(result)[0]!;
    assert.equal(entry.dynamics, "impulse");
    assert.ok((entry.durationSec ?? 0) > 0.04);
  },
);

test(
  "CLAP model embeds and tags a synth whoosh as a whoosh",
  { skip: !process.env.RUN_CLAP_TESTS && "set RUN_CLAP_TESTS=1 (loads the ~0.7 GB CLAP model)" },
  () => {
    const result = spawnSync("pnpm", ["-s", "audio:describe", "--input", "public/shared/sfx/synth/whoosh.wav"], {
      encoding: "utf8",
      timeout: 600000,
    });
    const line = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(line.ok, true);
    assert.ok(line.metadata.sfxKinds.slice(0, 3).some((tag: { tag: string }) => tag.tag === "whoosh"));
  },
);
