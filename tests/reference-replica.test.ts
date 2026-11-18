import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addReference } from "../src/lib/reference/add";
import { analyseReference } from "../src/lib/reference/analyse";
import { compareReference } from "../src/lib/reference/compare";
import { judgedCutTimes } from "../src/lib/film/targets";
import { correctedShots } from "../src/lib/reference/corrected";
import { readLayer } from "../src/lib/reference/library";
import { easeNeighbours, replicaFindings, REPLICA_TOLERANCES, type ReplicaPair } from "../src/lib/reference/replica";
import { checkReplicaSpec, textInShot } from "../src/lib/reference/replica-check";
import type { ReferenceEdit, ReferenceShots, ReferenceSpeechText } from "../src/types/reference";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "reference-replica-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function withoutUv(t: test.TestContext) {
  const previous = process.env.REFERENCE_UVX;
  process.env.REFERENCE_UVX = "/nonexistent/uvx";
  t.after(() => {
    if (previous === undefined) delete process.env.REFERENCE_UVX;
    else process.env.REFERENCE_UVX = previous;
  });
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** Three shots of distinct test patterns, cuts at 2 s and 4 s. */
function threeShots(file: string) {
  const inputs = ["testsrc2", "smptebars", "testsrc"].flatMap((name) => [
    "-f",
    "lavfi",
    "-i",
    `${name}=s=320x180:r=30:d=2`,
  ]);
  ffmpeg([
    ...inputs,
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "14",
    "-g",
    "15",
    file,
  ]);
}

const detector = (cuts: number[], end: number): ReferenceShots => {
  const edges = [0, ...cuts, end];
  return {
    schemaVersion: 1,
    referenceId: "film",
    detector: { name: "test", params: {} },
    candidates: [],
    summary: { count: cuts.length + 1, medianDurationSec: 1, cutsPerMinute: 1 },
    shots: edges.slice(0, -1).map((startSec, index) => ({
      id: `s00${index + 1}`,
      startSec,
      endSec: edges[index + 1]!,
      transitionIn: "cut" as const,
      transitionConfidence: 1,
    })),
  };
};
const correction = (value: ReferenceEdit["corrections"][number]["value"]) => ({
  value,
  basis: "observed" as const,
  confidence: 0.9,
  evidence: [],
});

test("corrected shots apply merges, rejects, splits and retypes with stable ids", () => {
  const shots = detector([1, 2, 3, 4], 5);
  assert.deepEqual(
    correctedShots(shots).map((shot) => shot.id),
    ["s001", "s002", "s003", "s004", "s005"],
  );
  const edit = {
    corrections: [
      correction({ kind: "merge", shotIds: ["s002", "s003"], note: "one layout" }),
      correction({ kind: "reject", shotIds: ["s005"], note: "type pop" }),
      correction({ kind: "split", shotIds: ["s001"], timeSec: 0.5, transition: "dissolve", note: "morph" }),
      correction({ kind: "retype", shotIds: ["s004"], transition: "whip", note: "fast slide" }),
    ],
  };
  const corrected = correctedShots(shots, edit);
  assert.deepEqual(
    corrected.slice(1).map((shot) => shot.startSec),
    judgedCutTimes(shots, edit),
    "the same cuts film:targets judges",
  );
  assert.deepEqual(
    corrected.map(({ id, startSec, endSec, transitionIn, sourceShots }) => ({
      id,
      startSec,
      endSec,
      transitionIn,
      sourceShots,
    })),
    [
      { id: "s001.1", startSec: 0, endSec: 0.5, transitionIn: "cut", sourceShots: ["s001"] },
      { id: "s001.2", startSec: 0.5, endSec: 1, transitionIn: "dissolve", sourceShots: ["s001"] },
      { id: "s002", startSec: 1, endSec: 3, transitionIn: "cut", sourceShots: ["s002", "s003"] },
      { id: "s004", startSec: 3, endSec: 5, transitionIn: "whip", sourceShots: ["s004", "s005"] },
    ],
  );
});

test("ease neighbours keep direction, step one place and keep back to itself", () => {
  assert.ok(easeNeighbours("power2.out", "power3.out"));
  assert.ok(easeNeighbours("circ.out", "power3.out"));
  assert.ok(easeNeighbours("none", "sine.inOut"));
  assert.ok(!easeNeighbours("power2.out", "power2.in"), "another direction");
  assert.ok(!easeNeighbours("power1.out", "power3.out"), "two steps");
  assert.ok(!easeNeighbours("back.out", "power3.out"));
  assert.ok(easeNeighbours("back.out", "back.out"));
});

const identity = { toRender: (seconds: number) => seconds };
const pair = (id: string, start: number, end: number, overrides: Partial<ReplicaPair> = {}): ReplicaPair => ({
  id,
  startSec: start,
  referenceShot: `ref-${id}`,
  referenceStartSec: start,
  durationSec: { reference: end - start, render: end - start },
  colour: { emdL: 1, emdA: 0, emdB: 0, reference: { L: 50, a: 0, b: 2 }, render: { L: 51, a: 0, b: 3 } },
  cameraComparable: false,
  ...overrides,
});

test("replica findings hold an exact copy and name a cut two frames late once", () => {
  const references = [
    { id: "ref-s1", startSec: 0, endSec: 2 },
    { id: "ref-s2", startSec: 2, endSec: 4 },
    { id: "ref-s3", startSec: 4, endSec: 6 },
  ];
  const exact = replicaFindings({
    fps: 30,
    referenceCuts: [2, 4],
    renderCuts: [2, 4],
    warp: identity,
    referenceShots: references,
    pairs: [pair("s1", 0, 2), pair("s2", 2, 4), pair("s3", 4, 6)],
  });
  assert.deepEqual(exact.findings, []);
  assert.deepEqual(exact.summary.withinTolerance.cuts, { held: 2, failed: 0, notMeasured: 0, exempt: 0 });
  assert.deepEqual(exact.summary.withinTolerance.cameraKind, { held: 0, failed: 0, notMeasured: 3, exempt: 0 });
  assert.equal(exact.summary.tolerances, REPLICA_TOLERANCES);

  const late = 4 + 2 / 30;
  const moved = replicaFindings({
    fps: 30,
    referenceCuts: [2, 4],
    renderCuts: [2, late],
    warp: identity,
    referenceShots: references,
    pairs: [
      pair("s1", 0, 2),
      pair("s2", 2, late, { durationSec: { reference: 2, render: late - 2 } }),
      pair("s3", late, 6, { durationSec: { reference: 2, render: 6 - late } }),
    ],
  });
  const cuts = moved.findings.filter((finding) => finding.component === "cuts");
  assert.equal(cuts.length, 1, JSON.stringify(moved.findings));
  assert.match(
    cuts[0]!.text,
    /^Reference cut at 4\.00 s lands at 4\.07 s here, 2 frames late after the film's offset; allowed 1 frame\.$/,
  );
  assert.equal(moved.findings.filter((finding) => finding.component === "timing").length, 2);

  const strict = replicaFindings({
    fps: 30,
    referenceCuts: [],
    renderCuts: [],
    warp: identity,
    referenceShots: [references[0]!],
    pairs: [
      pair("s1", 0, 2, {
        cameraComparable: true,
        camera: {
          kindMatch: 0.9,
          durationRatio: 1.12,
          amountRatio: 0.95,
          easeRmse: 0.03,
          referenceEase: "power3.out",
          renderEase: "power2.out",
          reference: ["push_in"],
          render: ["push_in"],
        },
        colour: { emdL: 6, emdA: 0, emdB: 0, reference: { L: 58, a: 0, b: 2 }, render: { L: 52, a: 0, b: 7 } },
      }),
    ],
  });
  const texts = strict.findings.map((finding) => finding.text);
  assert.ok(
    texts.includes(
      "s1 vs ref ref-s1: the move takes 12% longer than the reference's (5-95% span) (ratio 1.120; allowed ±10%)",
    ),
    JSON.stringify(texts),
  );
  assert.ok(
    texts.some((text) =>
      text.startsWith("s1 vs ref ref-s1: darker than the reference (mean L 52.0 against 58.0, EMD 6.00; allowed 5)"),
    ),
  );
  assert.ok(texts.some((text) => text.startsWith("s1 vs ref ref-s1: warmer than the reference")));
  assert.ok(!texts.some((text) => text.includes("ease")), "a neighbour ease holds");
  assert.match(
    strict.easeNotes.get("s1") ?? "",
    /power2\.out is a neighbour of the reference's power3\.out; curves differ by RMSE 0\.030/,
  );
  assert.deepEqual(strict.summary.withinTolerance.ease, { held: 1, failed: 0, notMeasured: 0, exempt: 0 });
  assert.deepEqual(strict.summary.withinTolerance.cameraAmount, { held: 1, failed: 0, notMeasured: 0, exempt: 0 });

  const swapped = replicaFindings({
    fps: 30,
    referenceCuts: [],
    renderCuts: [],
    warp: identity,
    referenceShots: [references[0]!],
    swappedShots: ["s1"],
    pairs: [
      pair("s1", 0, 2, {
        colour: { emdL: 30, emdA: 0, emdB: 20, reference: { L: 80, a: 0, b: 0 }, render: { L: 40, a: 0, b: 30 } },
      }),
    ],
  });
  assert.deepEqual(swapped.findings, [], "a swapped shot's palette is the user's choice");
  assert.deepEqual(swapped.summary.withinTolerance.lightness, { held: 0, failed: 0, notMeasured: 0, exempt: 1 });
  assert.deepEqual(swapped.summary.withinTolerance.warmth, { held: 0, failed: 0, notMeasured: 0, exempt: 1 });
});

test("screen text groups into shots with its box as a share of the frame", () => {
  const speechText: ReferenceSpeechText = {
    schemaVersion: 1,
    referenceId: "film",
    speech: { available: false, words: [] },
    screenText: {
      available: true,
      items: [
        { text: "HELLO", startSec: 0.4, endSec: 1.6, onsetSec: 0.5, box: { x: 0.1, y: 0.7, width: 0.8, height: 0.1 } },
        { text: "LATER", startSec: 2.2, endSec: 3, box: { x: 0, y: 0, width: 0.5, height: 0.05 } },
        { text: "NO BOX", startSec: 0.5, endSec: 1 },
      ],
    },
  };
  assert.deepEqual(textInShot(speechText, { startSec: 0, endSec: 2 }), [
    {
      text: "HELLO",
      startSec: 0.4,
      endSec: 1.6,
      onsetSec: 0.5,
      heightShare: 0.1,
      centre: { x: 0.5, y: 0.75 },
      box: { x: 0.1, y: 0.7, width: 0.8, height: 0.1 },
    },
  ]);
  assert.equal(textInShot(speechText, { startSec: 2, endSec: 4 })[0]?.text, "LATER");
});

test("ref:analyze measures shot colour that ref:compare --tolerance replica reads back, and replica-check validates a spec", async (t) => {
  withoutUv(t);
  const root = workspace(t);
  const film = path.join(root, "film.mp4");
  threeShots(film);
  const library = path.join(root, "library");
  const { directory } = addReference({ file: film, id: "film", libraryRoot: library, rights: "owned", crop: "none" });
  await analyseReference({ libraryRoot: library, id: "film", layers: ["shots"] });
  const shots = readLayer(directory, "shots.json")!;
  assert.equal(shots.shots.length, 3, JSON.stringify(shots.shots));
  assert.ok(
    shots.shots.every(
      (shot) => shot.colour && shot.colour.samples > 0 && shot.colour.percentiles.L[0] <= shot.colour.percentiles.L[2],
    ),
    JSON.stringify(shots.shots),
  );

  const render = path.join(root, "copy.mp4");
  copyFileSync(film, render);
  const renderShots = shots.shots.map(({ id, startSec, endSec }) => ({ id, startSec, endSec }));

  const loose = compareReference({ libraryRoot: library, id: "film", render, renderShots });
  assert.ok(!("summary" in loose.result) && !("tolerance" in loose.result), "the default output keeps its shape");

  const { result } = compareReference({ libraryRoot: library, id: "film", render, renderShots, tolerance: "replica" });
  assert.equal(result.tolerance, "replica");
  for (const pairRow of result.shots) {
    const measured = shots.shots.find((shot) => shot.id === pairRow.referenceShot)!.colour!;
    assert.ok("colour" in pairRow && pairRow.colour);
    assert.deepEqual(
      pairRow.colour.reference,
      { L: measured.L, a: measured.a, b: measured.b },
      "ref:analyze's colour is compare's reference side",
    );
  }
  assert.deepEqual(
    result.findings.filter((finding) => ["alignment", "cuts", "timing", "colour"].includes(finding.component)),
    [],
  );
  assert.deepEqual(result.summary!.withinTolerance.cuts, { held: 2, failed: 0, notMeasured: 0, exempt: 0 });
  assert.deepEqual(result.summary!.withinTolerance.shotDuration, { held: 3, failed: 0, notMeasured: 0, exempt: 0 });
  assert.equal(result.summary!.withinTolerance.ease.notMeasured, 3, "camera moves are not measured without uv");

  const shifted = renderShots.map((shot) => ({ ...shot }));
  shifted[1]!.endSec = shifted[2]!.startSec = Number((shifted[1]!.endSec + 2 / 30).toFixed(3));
  const moved = compareReference({
    libraryRoot: library,
    id: "film",
    render,
    renderShots: shifted,
    tolerance: "replica",
  }).result;
  assert.equal(
    moved.findings.filter((finding) => finding.component === "cuts").length,
    1,
    JSON.stringify(moved.findings),
  );

  const project = path.join(root, "project", "pipeline");
  spawnSync("mkdir", ["-p", project]);
  const specPath = path.join(project, "replica-spec.json");
  const spec = {
    reference: "film",
    fps: 30,
    format: "landscape",
    rights: { status: "owned", userStatement: "My own test film", askedAt: "2026-11-13" },
    swaps: [],
    shots: shots.shots.map((shot, index) => ({
      id: `r${index + 1}`,
      referenceShot: shot.id,
      startFrame: Math.round(shot.startSec * 30),
      durationFrames: Math.round(shot.endSec * 30) - Math.round(shot.startSec * 30),
      colour: { L: shot.colour!.L, a: shot.colour!.a, b: shot.colour!.b, source: "measured" },
      confidence: "measured",
    })),
    rounds: [],
  };
  writeFileSync(specPath, JSON.stringify(spec));
  const first = checkReplicaSpec({ specPath, libraryRoot: library, writeShots: true });
  assert.equal(first.metadata.passed, true, JSON.stringify(first.metadata.issues));
  assert.ok(first.metadata.warnings.some((warning) => warning.startsWith("no edit.json")));
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(project, "replica-shots.json"), "utf8")).shots.map(
      (shot: { id: string }) => shot.id,
    ),
    ["r1", "r2", "r3"],
  );
  assert.equal(first.metadata.measured.length, 3);

  const swappedSpec = {
    ...spec,
    swaps: [
      { what: "palette of r2", from: "reference colours", to: "user's brand colours", why: "brand", shots: ["r2"] },
    ],
  };
  writeFileSync(specPath, JSON.stringify(swappedSpec));
  const compareCli = (extra: string[]) => {
    const child = spawnSync(
      process.execPath,
      [
        tsx,
        path.join(repo, "scripts/ref-compare.ts"),
        "--id",
        "film",
        "--render",
        render,
        "--library-root",
        library,
        "--render-shots",
        path.join(project, "replica-shots.json"),
        ...extra,
      ],
      { encoding: "utf8", cwd: repo, env: { ...process.env, REFERENCE_UVX: "/nonexistent/uvx" } },
    );
    return JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  };
  const withSwaps = compareCli(["--tolerance", "replica", "--spec", specPath]);
  assert.equal(withSwaps.ok, true, JSON.stringify(withSwaps));
  assert.deepEqual(withSwaps.metadata.summary.withinTolerance.lightness, {
    held: 2,
    failed: 0,
    notMeasured: 0,
    exempt: 1,
  });
  assert.equal(compareCli(["--spec", specPath]).error, "INVALID_INPUT", "a spec needs --tolerance replica");
  writeFileSync(specPath, JSON.stringify(spec));

  const broken = structuredClone(spec);
  broken.shots[1]!.durationFrames += 3;
  broken.shots[2]!.colour.L += 10;
  broken.shots[0]!.referenceShot = "s009";
  writeFileSync(specPath, JSON.stringify(broken));
  const issues = checkReplicaSpec({ specPath, libraryRoot: library }).metadata.issues;
  assert.ok(
    issues.some((issue) => /^shots sum to \d+ frames; the reference is 180 frames/.test(issue)),
    JSON.stringify(issues),
  );
  assert.ok(issues.includes("r3: overlap of 3 frames after r2"), JSON.stringify(issues));
  assert.ok(issues.some((issue) => issue.startsWith("r3: colour target")));
  assert.ok(issues.includes("reference shot s001 (0-2 s) is not covered"));
  assert.ok(issues.some((issue) => issue.startsWith("r1: referenceShot s009 is not a corrected shot")));
  assert.ok(issues.includes("replica-shots.json is out of step with the spec; rerun with --write-shots"));

  const motion = {
    schemaVersion: 1,
    referenceId: "film",
    method: "test",
    shots: [
      {
        shotId: "s002",
        meanEnergy: 0.1,
        peakEnergy: 0.2,
        camera: {
          kind: ["push_in"],
          amount: { x: 0, y: 0, z: 0.2, r: 0 },
          moves: 1,
          axis: "z",
          ease: {
            gsap: "power3.out",
            gsapRmse: 0.01,
            cubicBezier: [0.2, 0.6, 0.3, 1],
            css: "cubic-bezier(0.2, 0.6, 0.3, 1)",
            bezierRmse: 0.01,
            spring: { omega: 8, zeta: 0.9, settleSec: 0.6, remotion: { mass: 1, stiffness: 64, damping: 14.4 } },
            springRmse: 0.02,
            best: "gsap",
            pick: "gsap",
            overshoot: 0,
          },
        },
      },
    ],
    energyCurve: [],
  };
  writeFileSync(path.join(directory, "motion.json"), JSON.stringify(motion));
  const eased = structuredClone(spec) as typeof spec & { shots: { camera?: unknown }[] };
  eased.shots[1]!.camera = { kind: ["push_in"], ease: { pick: "gsap", gsap: "power2.out" } };
  writeFileSync(specPath, JSON.stringify(eased));
  assert.ok(
    checkReplicaSpec({ specPath, libraryRoot: library }).metadata.issues.includes(
      "r2: ease.gsap power2.out is not the reference's fitted power3.out",
    ),
  );
  eased.shots[1]!.camera = {
    kind: ["push_in"],
    ease: { pick: "spring", spring: { remotion: { mass: 1, stiffness: 64.2, damping: 14.4 } } },
  };
  writeFileSync(specPath, JSON.stringify(eased));
  const spring = checkReplicaSpec({ specPath, libraryRoot: library }).metadata;
  assert.deepEqual(spring.issues, [], "a spring within 1% is the fitted one");
  assert.ok(spring.warnings.includes("r2: ease.pick spring; the fit prefers gsap"));

  const edit = {
    schemaVersion: 1,
    referenceId: "film",
    rhythm: { value: "even", basis: "observed", confidence: 0.8, evidence: [] },
    shots: [],
    corrections: [correction({ kind: "merge", shotIds: ["s002", "s003"], note: "one layout" })],
  };
  writeFileSync(path.join(directory, "edit.json"), JSON.stringify(edit));
  writeFileSync(specPath, JSON.stringify(spec));
  const merged = checkReplicaSpec({ specPath, libraryRoot: library }).metadata;
  assert.ok(
    merged.issues.some((issue) => issue === "r3: referenceShot s003 is not a corrected shot; it is merged into s002"),
    JSON.stringify(merged.issues),
  );
  assert.equal(merged.measured.length, 2);
  assert.equal(merged.measured[1]!.durationFrames, 120);

  writeFileSync(
    path.join(directory, "edit.json"),
    JSON.stringify({
      ...edit,
      corrections: [correction({ kind: "split", shotIds: ["s001"], timeSec: 1, note: "morph" })],
    }),
  );
  const split = checkReplicaSpec({ specPath, libraryRoot: library }).metadata;
  assert.deepEqual(
    split.measured.map((row) => row.referenceShot),
    ["s001.1", "s001.2", "s002", "s003"],
  );
  assert.ok(
    split.measured.every((row) => "colour" in row && row.colour),
    "split parts are measured from the media",
  );
  assert.ok(
    split.issues.some((issue) =>
      issue.startsWith("r1: referenceShot s001 is not a corrected shot; it was split into s001.1, s001.2"),
    ),
    JSON.stringify(split.issues),
  );

  writeFileSync(specPath, '{"reference":"film"}');
  const envelope = spawnSync(
    process.execPath,
    [tsx, path.join(repo, "scripts/ref-replica-check.ts"), "--spec", specPath, "--library-root", library],
    { encoding: "utf8", cwd: repo },
  );
  const lines = envelope.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "VALIDATION");
  assert.ok(existsSync(specPath));
});

const needsUv =
  process.env.RUN_REFERENCE_UV === "1" ? false : "set RUN_REFERENCE_UV=1 (needs uv and a first package download)";

function easedPush(root: string, name: string, frames: number) {
  const still = path.join(root, "still.png");
  if (!existsSync(still)) ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=2560x1440:r=30:d=1", "-frames:v", "1", still]);
  const file = path.join(root, name);
  ffmpeg([
    "-loop",
    "1",
    "-i",
    still,
    "-vf",
    `zoompan=z='1+0.25*(1-pow(1-min(1\\,on/${frames})\\,3))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=640x360:fps=30`,
    "-frames:v",
    "90",
    "-c:v",
    "libx264",
    "-qp",
    "12",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}

test("replica tolerance holds the same push and fails a faster one on its length", { skip: needsUv }, async (t) => {
  const root = workspace(t);
  const reference = easedPush(root, "slow.mp4", 60);
  const library = path.join(root, "library");
  addReference({ file: reference, id: "slow", libraryRoot: library, crop: "none" });
  await analyseReference({ libraryRoot: library, id: "slow", layers: ["shots", "motion"] });
  const renderShots = [{ id: "r1", startSec: 0, endSec: 3 }];
  const same = compareReference({
    libraryRoot: library,
    id: "slow",
    render: easedPush(root, "same.mp4", 60),
    renderShots,
    tolerance: "replica",
  }).result;
  for (const measure of ["cameraKind", "cameraLength", "cameraAmount", "ease"] as const)
    assert.deepEqual(
      same.summary!.withinTolerance[measure],
      { held: 1, failed: 0, notMeasured: 0, exempt: 0 },
      `${measure}: ${JSON.stringify(same.shots)}`,
    );
  const fast = compareReference({
    libraryRoot: library,
    id: "slow",
    render: easedPush(root, "fast.mp4", 30),
    renderShots,
    tolerance: "replica",
  }).result;
  assert.deepEqual(
    fast.summary!.withinTolerance.cameraLength,
    { held: 0, failed: 1, notMeasured: 0, exempt: 0 },
    JSON.stringify(fast.shots),
  );
  assert.ok(
    fast.findings.some(
      (finding) => finding.component === "camera" && /takes \d+% less time than the reference's/.test(finding.text),
    ),
    JSON.stringify(fast.findings),
  );
});
