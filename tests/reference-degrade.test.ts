import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { degradeReference } from "../src/lib/reference/degrade";
import { writeCriticPackets } from "../src/lib/reference/calibrate";
import {
  CalibrationManifestSchema,
  CalibrationReportSchema,
  CriticKeySchema,
  type CalibrationManifest,
} from "../src/types/calibration";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");

// A synthetic reference: five shots of flat colour, each with a box that eases in across it, and a click on every cut.
const LENGTHS = [1.0, 2.6, 0.6, 1.8, 4.0];
const CUTS = [1.0, 3.6, 4.2, 6.0];
const FPS = 30;

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function makeReference(root: string, id = "synthetic") {
  const directory = path.join(root, id);
  mkdirSync(path.join(directory, "media"), { recursive: true });
  const colours = ["red", "blue", "green", "yellow", "purple"];
  const inputs: string[] = [];
  const parts: string[] = [];
  LENGTHS.forEach((length, index) => {
    inputs.push("-f", "lavfi", "-i", `color=c=${colours[index]}:s=320x180:r=${FPS}:d=${length}`);
    parts.push(
      `color=c=white:s=60x60:r=${FPS}:d=${length}[box${index}]`,
      `[${index}:v][box${index}]overlay=x='260*(t/${length})*(t/${length})':y=60:shortest=1,format=yuv420p,setsar=1[v${index}]`,
    );
  });
  const duration = LENGTHS.reduce((sum, length) => sum + length, 0);
  const clicks = CUTS.map((time) => `between(t\\,${time}\\,${time + 0.03})`).join("+");
  inputs.push(
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=exprs='0.05*sin(2*PI*220*t)+0.8*sin(2*PI*1000*t)*(${clicks})':s=48000:d=${duration}`,
  );
  const chain = `${parts.join(";")};${LENGTHS.map((_, index) => `[v${index}]`).join("")}concat=n=${LENGTHS.length}:v=1:a=0[out]`;
  const media = path.join(directory, "media", "source.mp4");
  ffmpeg([
    ...inputs,
    "-filter_complex",
    chain,
    "-map",
    "[out]",
    "-map",
    `${LENGTHS.length}:a`,
    "-c:v",
    "libx264",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(duration),
    media,
  ]);
  writeFileSync(
    path.join(directory, "source.json"),
    JSON.stringify({
      schemaVersion: 1,
      referenceId: id,
      origin: { kind: "file", originalFilename: "synthetic.mp4", acquiredAt: "2026-11-15T00:00:00.000Z" },
      sha256: "a".repeat(64),
      mediaPath: "media/source.mp4",
      probe: { durationSec: duration, width: 320, height: 180, fps: FPS, hasAudio: true },
      rights: { status: "study-only" },
      crop: null,
    }),
  );
  const edges = [0, ...CUTS, duration];
  writeFileSync(
    path.join(directory, "shots.json"),
    JSON.stringify({
      schemaVersion: 1,
      referenceId: id,
      detector: { name: "fixture" },
      shots: edges.slice(0, -1).map((start, index) => ({
        id: `s${index + 1}`,
        startSec: start,
        endSec: edges[index + 1],
        transitionIn: "cut",
        transitionConfidence: 1,
      })),
      summary: { count: LENGTHS.length, medianDurationSec: 1.8, cutsPerMinute: 24 },
    }),
  );
  return directory;
}

/** Tiny grey frames, one buffer per frame. */
function greyFrames(file: string, width = 32, height = 18): Buffer[] {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-vf",
      `scale=${width}:${height}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
  const size = width * height;
  return Array.from({ length: result.stdout.length / size }, (_, index) =>
    result.stdout.subarray(index * size, (index + 1) * size),
  );
}

const difference = (a: Buffer, b: Buffer) =>
  a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;
const cutFrames = (frames: Buffer[]) =>
  frames.flatMap((frame, index) => (index > 0 && difference(frame, frames[index - 1]!) > 25 ? [index] : []));

function samples(file: string): Float32Array {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
  return new Float32Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.length / 4);
}

const firstLoud = (pcm: Float32Array, threshold = 0.3) => pcm.findIndex((value) => Math.abs(value) > threshold) / 48000;
const crest = (pcm: Float32Array) => {
  let peak = 0;
  let squares = 0;
  for (const value of pcm) {
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
  }
  return peak / Math.sqrt(squares / pcm.length);
};

test(
  "ref:degrade makes a valid clip of each kind with the property it claims, and a deterministic manifest",
  { timeout: 600000 },
  (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "reference-degrade-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeReference(root);
    const run = (outDir: string, kinds?: CalibrationManifest["skipped"][number]["kind"][]) => {
      const result = degradeReference({
        libraryRoot: root,
        id: "synthetic",
        segments: [{ startSec: 3, endSec: 6 }],
        outDir,
        ...(kinds ? { kinds } : {}),
      });
      assert.equal(result.manifests.length, 1);
      return {
        file: result.manifests[0]!,
        manifest: CalibrationManifestSchema.parse(JSON.parse(readFileSync(result.manifests[0]!, "utf8"))),
      };
    };
    const { file, manifest } = run(path.join(root, "out"));
    const dir = path.dirname(file);
    const at = (relative: string) => path.join(dir, relative);
    const variant = (id: string) => manifest.variants.find((row) => row.id === id)!;
    assert.deepEqual(manifest.variants.map((row) => row.id).sort(), [
      "desync-early",
      "desync-late",
      "flat-grade",
      "linear-motion",
      "soft-transients",
      "stutter",
      "uniform-cuts",
    ]);
    assert.equal(variant("soft-transients").kind, "soft-transients", "no stems: no-sfx becomes soft-transients");
    assert.equal(manifest.original.frameCount, 90);
    for (const row of manifest.variants)
      assert.equal(row.frameCount, row.against === "original" ? 90 : manifest.originalLong!.frameCount, row.id);
    for (const [relative, sha] of Object.entries(manifest.sha256s)) assert.match(sha, /^[a-f0-9]{64}$/, relative);

    // Original: the cuts at 3.6 and 4.2 s land on frames 18 and 36 of the clip.
    const original = greyFrames(at(manifest.original.path));
    assert.equal(original.length, 90);
    assert.deepEqual(cutFrames(original), [18, 36]);

    // uniform-cuts: the long span's five shots all one length.
    const long = manifest.originalLong!;
    assert.ok(
      long.endSec - long.startSec >= 8 - 1e-6 && long.endSec - long.startSec <= 12 + 1e-6,
      `${long.startSec}-${long.endSec}`,
    );
    const uniform = cutFrames(greyFrames(at(variant("uniform-cuts").path)));
    const lengths = [0, ...uniform, long.frameCount]
      .slice(1)
      .map((edge, index, all) => edge - (index ? all[index - 1]! : 0));
    assert.equal(lengths.length, 5, `cuts ${uniform}`);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= 1, `equal shot lengths: ${lengths}`);
    const before = cutFrames(greyFrames(at(long.path)));
    const lengthsBefore = [0, ...before, long.frameCount]
      .slice(1)
      .map((edge, index, all) => edge - (index ? all[index - 1]! : 0));
    assert.ok(
      Math.max(...lengthsBefore) - Math.min(...lengthsBefore) > 10,
      `the original long span varies: ${lengthsBefore}`,
    );

    // desync: the picture's cut moves 4 frames against the click, which stays put.
    const clickOriginal = firstLoud(samples(at(manifest.original.path)));
    for (const [id, offset] of [
      ["desync-late", 4],
      ["desync-early", -4],
    ] as const) {
      const shifted = greyFrames(at(variant(id).path));
      assert.equal(cutFrames(shifted)[0], 18 + offset, id);
      assert.ok(Math.abs(firstLoud(samples(at(variant(id).path))) - clickOriginal) < 0.005, `${id}: sound unchanged`);
    }
    assert.ok(Math.abs(clickOriginal - 0.6) < 0.03, `the click sits on the cut: ${clickOriginal}`);

    // stutter: frames held in threes, where the original moves every frame.
    const fine = (file: string) => greyFrames(file, 160, 90);
    const holds = (frames: Buffer[]) =>
      frames
        .map((frame, index) => (index % 3 !== 0 ? difference(frame, frames[index - 1]!) : -1))
        .filter((value) => value >= 0);
    const stutterHolds = holds(fine(at(variant("stutter").path)));
    const originalHolds = holds(fine(at(manifest.original.path)));
    assert.ok(stutterHolds.filter((value) => value < 0.3).length >= 55, `held frames: ${stutterHolds.join(" ")}`);
    assert.ok(
      originalHolds.filter((value) => value < 0.3).length < 30,
      `the original moves: ${originalHolds.join(" ")}`,
    );

    // soft-transients: the click's peak flattened against the body of the sound.
    assert.ok(
      crest(samples(at(variant("soft-transients").path))) < crest(samples(at(manifest.original.path))) * 0.8,
      "crest factor falls",
    );

    // linear-motion: retimed inside shots, cuts where they were.
    assert.ok(Number(variant("linear-motion").params["retimedFrames"]) > 10);
    assert.deepEqual(cutFrames(greyFrames(at(variant("linear-motion").path))), [18, 36]);

    // Deterministic: the same request writes the same manifest, hashes included.
    const again = run(path.join(root, "again"), ["stutter", "flat-grade"]);
    const first = run(path.join(root, "first"), ["stutter", "flat-grade"]);
    assert.deepEqual(again.manifest, first.manifest);
    assert.equal(first.manifest.original.sha256, manifest.original.sha256);

    // judge:calibrate on these pairs: the candidate readings move the way their kinds claim, through the CLI contract.
    const reportFile = path.join(root, "report.json");
    const child = spawnSync(
      process.execPath,
      [
        tsx,
        path.join(repo, "scripts/judge-calibrate.ts"),
        "--manifest",
        file,
        "--sensors",
        "candidate,shot-length-variety",
        "--output",
        reportFile,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTBROS_MEMORY_ROOT: path.join(root, "memory"),
        },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `one JSON line: ${child.stdout} ${child.stderr}`);
    assert.equal(JSON.parse(lines[0]!).ok, true, child.stdout);
    const report = CalibrationReportSchema.parse(JSON.parse(readFileSync(reportFile, "utf8")));
    const row = (sensor: string, kind: string) =>
      report.sensors.find((entry) => entry.sensor === sensor && entry.kind === kind)!;
    assert.equal(row("colour-saturation", "flat-grade").detections, 1, "flat-grade is less saturated");
    assert.equal(row("motion-energy-contrast", "linear-motion").detections, 1, JSON.stringify(report.failures));
    assert.equal(row("shot-length-variety", "uniform-cuts").detections, 1, JSON.stringify(report.failures));
    assert.equal(row("colour-saturation", "stutter").role, "control");

    // Critic packets are blind: neutral names, no kind, both orders, and a separate key.
    const criticDir = path.join(root, "critic");
    const packets = writeCriticPackets([file], criticDir, "test-seed");
    assert.equal(packets.questions, manifest.variants.length * 2);
    assert.ok(
      path.relative(criticDir, packets.key).startsWith(".."),
      `the answer key sits outside the critic's folder: ${packets.key}`,
    );
    assert.throws(
      () => writeCriticPackets([file], criticDir, "test-seed", { keyFile: path.join(criticDir, "key.json") }),
      /outside/,
    );
    const pairsText = readFileSync(packets.pairs, "utf8");
    for (const word of ["original", "stutter", "desync", "uniform", "linear", "flat", "soft", "manifest"])
      assert.ok(!pairsText.includes(word), `pairs.json leaks "${word}"`);
    const pairs = JSON.parse(pairsText) as { questions: { pairId: string; order: string; strip: string; a: string }[] };
    for (const question of pairs.questions)
      assert.ok(
        statSync(path.join(criticDir, question.strip)).size > 0 && statSync(path.join(criticDir, question.a)).size > 0,
      );
    assert.equal(new Set(pairs.questions.map((question) => question.pairId)).size, manifest.variants.length);
    const key = CriticKeySchema.parse(JSON.parse(readFileSync(packets.key, "utf8")));
    assert.ok(
      key.pairs.some((pair) => pair.original === "x") && key.pairs.some((pair) => pair.original === "y"),
      "the original is not always first",
    );

    // Batches: one fresh critic each; no batch shows the original twice or both orders of a pair, and nothing links two batches.
    const batchDir = path.join(root, "critic-batches");
    const n = manifest.variants.length * 2;
    assert.throws(
      () => writeCriticPackets([file], batchDir, "test-seed", { batches: n - 1 }),
      new RegExp(`--batches ${n} or more`),
    );
    const batched = writeCriticPackets([file], batchDir, "test-seed", { batches: n });
    assert.equal(batched.batches!.length, n, "every batch has one question");
    assert.ok(!existsSync(path.join(batchDir, "pairs.json")), "no file in the critic folder holds every question");
    const batchKey = CriticKeySchema.parse(JSON.parse(readFileSync(batched.key, "utf8")));
    const hashes = new Set<string>();
    for (const [index, sheet] of batched.batches!.entries()) {
      const text = readFileSync(sheet, "utf8");
      for (const pair of batchKey.pairs)
        assert.ok(!text.includes(pair.pairId), `batch-${index} names the pair id ${pair.pairId}`);
      const questions = (JSON.parse(text) as { questions: { pairId: string; a: string; b: string }[] }).questions;
      assert.equal(questions.length, 1);
      for (const question of questions)
        for (const clip of [question.a, question.b]) {
          assert.match(clip, new RegExp(`^batch-${index}/q[a-f0-9]{12}-[AB]\\.mp4$`));
          assert.equal(statSync(path.join(batchDir, clip)).nlink, 1, "a copy, not a link to the labelled clip");
          hashes.add(
            `${index}|${createHash("sha256")
              .update(readFileSync(path.join(batchDir, clip)))
              .digest("hex")}`,
          );
        }
    }
    assert.equal(hashes.size, n * 2, "within a batch no two clips share bytes");
    const answers = batched.batches!.map((sheet, index) => {
      const out = path.join(root, `results-${index}.json`);
      const questions = (JSON.parse(readFileSync(sheet, "utf8")) as { questions: { pairId: string }[] }).questions;
      writeFileSync(
        out,
        JSON.stringify(
          questions.map((question) => ({ pairId: question.pairId, order: "ab", winner: "A", reason: "test" })),
        ),
      );
      return out;
    });
    const judged = spawnSync(
      process.execPath,
      [
        tsx,
        path.join(repo, "scripts/judge-calibrate.ts"),
        "--manifest",
        file,
        "--sensors",
        "none",
        "--critic-key",
        batched.key,
        "--critic-results",
        answers.join(","),
        "--output",
        path.join(root, "critic-report.json"),
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTBROS_MEMORY_ROOT: path.join(root, "memory"),
        },
      },
    );
    const result = JSON.parse(judged.stdout.trim().split("\n").at(-1)!) as {
      ok: boolean;
      metadata: { critic: { pairs: number } };
    };
    assert.equal(result.ok, true, judged.stdout + judged.stderr);
    assert.equal(result.metadata.critic.pairs, manifest.variants.length);
    const short = spawnSync(
      process.execPath,
      [
        tsx,
        path.join(repo, "scripts/judge-calibrate.ts"),
        "--manifest",
        file,
        "--sensors",
        "none",
        "--critic-key",
        batched.key,
        "--critic-results",
        answers.slice(1).join(","),
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTBROS_MEMORY_ROOT: path.join(root, "memory"),
        },
      },
    );
    assert.match(short.stdout, /Unanswered questions: batch-\d+ 1 of 1/);
  },
);
