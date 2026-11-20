/** Colour grading: grade contracts, the worker's colour science, scopes, compare, match, grade, shots and windows. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { parseCrop } from "../src/lib/colour/args";
import { decodeTags, fillSegments, loadTimeline, normaliseGrade } from "../src/lib/colour/grade";
import { runColourWorker } from "../src/lib/colour/worker";
import { GradeSchema } from "../src/types/colour";

const repo = path.resolve(import.meta.dirname, "..");
const hasUv = spawnSync(process.env.COLOUR_UV ?? "uv", ["--version"]).status === 0;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const worker = { skip: hasUv && hasFfmpeg ? false : "needs uv and ffmpeg", timeout: 600_000 } as const;
const work = mkdtempSync(path.join(tmpdir(), "colour-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

const TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
function ffmpeg(...args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
function encode(file: string, filter: string, seconds = 1) {
  ffmpeg("-f", "lavfi", "-i", filter, "-t", String(seconds), "-vf", "format=yuv420p", "-c:v", "libx264", "-crf", "4", ...TAGS, file);
  return file;
}
function cli(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts", script), ...args], {
    encoding: "utf8",
    timeout: 600_000,
    cwd: repo,
    env: { ...process.env, AGENTBROS_EVENTS: "off" },
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout + result.stderr);
  const envelope = JSON.parse(lines[0]!) as { ok: boolean; outputs?: string[]; metadata?: Record<string, unknown>; message?: string };
  assert.equal(envelope.ok, true, envelope.message ?? result.stderr);
  return envelope;
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("grade contract: one number per channel expands, unknown keys are refused, LUT paths resolve", () => {
  const grade = GradeSchema.parse({ lift: 0.02, gain: [1, 1.1, 0.9], saturation: 0.9 });
  const lutDir = mkdtempSync(path.join(work, "lut-"));
  writeFileSync(path.join(lutDir, "look.cube"), "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
  const normalised = normaliseGrade({ ...grade, luts: [{ path: "look.cube", position: "look", strength: 1 }] }, path.join(lutDir, "g.json"));
  assert.deepEqual(normalised.lift, [0.02, 0.02, 0.02]);
  assert.deepEqual(normalised.gain, [1, 1.1, 0.9]);
  assert.equal((normalised.luts as { path: string }[])[0]!.path, path.join(lutDir, "look.cube"));
  assert.equal(GradeSchema.safeParse({ lfit: 0.1 }).success, false);
  assert.equal(GradeSchema.safeParse({ windows: [{ name: "w", mask: { kind: "shape", box: [0.1, 0.1, 0.2, 0.2] }, grade: { exposure: 1 } }] }).success, true);
});

test("timelines: overlaps are refused and gaps are filled with the base grade", () => {
  const file = path.join(work, "timeline.json");
  writeFileSync(file, JSON.stringify({ version: 1, segments: [{ start: 0, end: 2, grade: "a.json" }, { start: 1.5, end: 3, grade: "b.json" }] }));
  assert.throws(() => loadTimeline(file), /overlap/);
  const filled = fillSegments([{ start: 1, end: 2, cube: "a" }], 4, null);
  assert.deepEqual(filled, [
    { start: 0, end: 1, cube: null },
    { start: 1, end: 2, cube: "a" },
    { start: 2, end: 4, cube: null },
  ]);
});

test("decoding: tags win, untagged HD is BT.709 limited and says so; crops parse", () => {
  const base = { width: 1468, height: 626, pixFmt: "yuv420p", duration: 1, hasAudio: false };
  assert.deepEqual(decodeTags({ ...base, colorSpace: "smpte170m", colorRange: "pc" }).matrix, "bt601");
  const untagged = decodeTags(base);
  assert.equal(untagged.matrix, "bt709");
  assert.equal(untagged.range, "limited");
  assert.equal(untagged.assumed.length, 2);
  assert.equal(decodeTags({ ...base, width: 720, height: 480 }).matrix, "bt601");
  assert.deepEqual(parseCrop("0,88,1280,544"), [0, 88, 1280, 544]);
  assert.throws(() => parseCrop("1,2,3"), /x,y,w,h/);
});

test("worker colour science: CIEDE2000 matches Sharma's published pairs; red sits at 103 degrees", worker, () => {
  const result = runColourWorker(
    "selftest",
    {},
    z.object({ ok: z.literal(true), deltaE2000: z.array(z.number()), expected: z.array(z.number()), redAngleDeg: z.number() }),
  );
  result.deltaE2000.forEach((value, i) => assert.ok(Math.abs(value - result.expected[i]!) < 1e-3, `pair ${i}: ${value}`));
  assert.ok(Math.abs(result.redAngleDeg - 102.9) < 0.2);
});

test("scopes: letterboxed bars are cropped, every scope and the numbers are written, deterministically", worker, () => {
  const bars = encode(path.join(work, "bars-letterbox.mp4"), "smptehdbars=s=640x272:r=25,pad=640:360:0:44:black");
  const runs = ["a", "b"].map((name) => cli("colour-scopes.ts", ["--input", bars, "--frames", "2", "--output", path.join(work, `scopes-${name}`)]));
  const meta = runs[0]!.metadata as { activePicture: { cropped: boolean; y: number; height: number }; files: Record<string, string>; clipping: unknown };
  assert.equal(meta.activePicture.cropped, true);
  assert.ok(Math.abs(meta.activePicture.y - 44) <= 2 && Math.abs(meta.activePicture.height - 272) <= 4, JSON.stringify(meta.activePicture));
  for (const name of ["sheet", "waveform-luma", "waveform-rgb", "parade", "vectorscope", "vectorscope-2x", "histogram", "cie", "false-colour"])
    assert.ok(existsSync(meta.files[name]!), name);
  const stats = JSON.parse(readFileSync(path.join(work, "scopes-a", "stats.json"), "utf8")) as { stats: { legal: { yBelowPct: number }; luma: unknown } };
  assert.ok(stats.stats.legal.yBelowPct > 0, "SMPTE HD bars carry a -2% sub-black PLUGE step");
  assert.equal(sha(path.join(work, "scopes-a", "sheet.png")), sha(path.join(work, "scopes-b", "sheet.png")));
  assert.equal(readFileSync(path.join(work, "scopes-a", "stats.json"), "utf8").replace(/scopes-a/g, "x"), readFileSync(path.join(work, "scopes-b", "stats.json"), "utf8").replace(/scopes-b/g, "x"));
});

test("compare, match and grade: a blue-tinted gradient is diagnosed cooler and matched back with evidence", worker, () => {
  const gradient = "gradients=s=480x270:c0=0x302010:c1=0xe0d0b0:x0=0:y0=0:x1=480:y1=270:r=25";
  const source = encode(path.join(work, "gradient.mp4"), gradient);
  const tinted = encode(path.join(work, "gradient-cool.mp4"), `${gradient},colorchannelmixer=rr=0.88:bb=1.12`);
  const compared = cli("colour-compare.ts", ["--input", tinted, "--reference", source, "--frames", "2", "--output", path.join(work, "cmp")]);
  const summary = String(compared.metadata!.summary);
  assert.match(summary, /cooler/);
  const before = (compared.metadata!.zones as { meanDeltaE2000: number }).meanDeltaE2000;
  const gradeFile = path.join(work, "match.grade.json");
  cli("colour-match.ts", ["--input", tinted, "--reference", source, "--frames", "2", "--output", gradeFile]);
  const grade = GradeSchema.parse(JSON.parse(readFileSync(gradeFile, "utf8")));
  assert.equal(grade.matchedTo?.method, "stats");
  const graded = path.join(work, "gradient-graded.mp4");
  cli("colour-grade.ts", ["--grade", gradeFile, "--input", tinted, "--output", graded, "--export-cube", path.join(work, "match.cube"), "--lut-size", "17"]);
  assert.match(readFileSync(path.join(work, "match.cube"), "utf8"), /LUT_3D_SIZE 17\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0/);
  const after = cli("colour-compare.ts", ["--input", graded, "--reference", source, "--frames", "2", "--output", path.join(work, "cmp-after")]);
  const afterDe = (after.metadata!.zones as { meanDeltaE2000: number }).meanDeltaE2000;
  assert.ok(afterDe < before / 2, `zone dE2000 ${before} -> ${afterDe}`);
  assert.throws(() => cli("colour-match.ts", ["--input", tinted, "--reference", source, "--output", gradeFile]), /exists/);
});

test("identity grade round trip through ffmpeg stays below one CIEDE2000 unit", worker, () => {
  const bars = encode(path.join(work, "bars.mp4"), "smptehdbars=s=640x360:r=25");
  const identity = path.join(work, "identity.json");
  writeFileSync(identity, "{}\n");
  const out = path.join(work, "bars-identity.mp4");
  cli("colour-grade.ts", ["--grade", identity, "--input", bars, "--output", out]);
  const compared = cli("colour-compare.ts", ["--input", out, "--reference", bars, "--frames", "1", "--crop", "none", "--reference-crop", "none", "--output", path.join(work, "cmp-id")]);
  const paired = compared.metadata!.paired as { reliable: boolean; deltaE2000: { mean: number } };
  assert.equal(paired.reliable, true);
  assert.ok(paired.deltaE2000.mean < 1, JSON.stringify(paired));
});

test("windows: a tracked patch is followed within its shot, and the window grades only inside its mask", worker, () => {
  const clip = encode(
    path.join(work, "moving.mp4"),
    "color=c=0x404040:s=480x270:r=25[bg];testsrc2=s=60x60:r=25[p];[bg][p]overlay=x='40+t*120':y=100:shortest=1",
    2,
  );
  const track = path.join(work, "patch.track.json");
  cli("colour-track.ts", ["--input", clip, "--box", "40,100,60,60", "--at", "0", "--output", track]);
  const keyframes = (JSON.parse(readFileSync(track, "utf8")) as { keyframes: { t: number; x: number }[] }).keyframes;
  const last = keyframes.at(-1)!;
  assert.ok(Math.abs(last.x * 480 - (40 + last.t * 120)) < 6, `tracked x ${last.x * 480} at ${last.t}s`);
  const gradeFile = path.join(work, "window.grade.json");
  writeFileSync(gradeFile, JSON.stringify({ windows: [{ name: "patch", mask: { kind: "shape", shape: "rectangle", track: "patch.track.json", softness: 0.05 }, grade: { exposure: 1 } }] }));
  const graded = path.join(work, "moving-window.mp4");
  cli("colour-grade.ts", ["--grade", gradeFile, "--input", clip, "--output", graded]);
  const frame = (file: string) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 24 });
    return result.stdout;
  };
  const a = frame(clip);
  const b = frame(graded);
  const at = (buf: Buffer, x: number, y: number) => buf[y * 480 + x]!;
  assert.ok(Math.abs(at(b, 400, 30) - at(a, 400, 30)) <= 3, "outside the window the frame is unchanged");
  const mean = (buf: Buffer, x0: number, y0: number, size: number) => {
    let sum = 0;
    for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) sum += at(buf, x, y);
    return sum / (size * size);
  };
  const patch = 40 + 1 * 120 + 10;
  assert.ok(mean(b, patch, 110, 40) > mean(a, patch, 110, 40) + 6, "inside the tracked window the frame is brighter");
});

test("shots: a cut between a neutral and a tinted shot is found and the tinted shot is flagged", worker, () => {
  const a = encode(path.join(work, "shot-a.mp4"), "testsrc2=s=320x180:r=25", 1);
  const b = encode(path.join(work, "shot-b.mp4"), "testsrc2=s=320x180:r=25,colorchannelmixer=rr=0.7:bb=1.2,eq=brightness=-0.08", 1);
  const edit = path.join(work, "edit.mp4");
  ffmpeg("-i", a, "-i", b, "-filter_complex", "[0][1]concat=n=2:v=1:a=0,format=yuv420p", "-c:v", "libx264", "-crf", "4", ...TAGS, edit);
  const result = cli("colour-shots.ts", ["--input", edit, "--output", path.join(work, "shots"), "--solve"]);
  const shots = result.metadata!.shots as { label: string; outOfTolerance: boolean; start: number }[];
  assert.equal(shots.length, 2, JSON.stringify(shots));
  assert.ok(Math.abs(shots[1]!.start - 1) < 0.25);
  assert.equal(shots[1]!.outOfTolerance, true);
  assert.ok(existsSync(path.join(work, "shots", "timeline.json")));
});
