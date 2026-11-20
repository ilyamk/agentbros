/** Colour grading: grade contracts, colour science, scopes, compare, match, grade, shots, windows, targets, looks and LUTs. */
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
import { LOOKS, looksForMood } from "../src/lib/colour/looks";
import { formatMarkdown, looksDoc } from "../src/lib/colour/looks-doc";
import { runColourWorker } from "../src/lib/colour/worker";
import { ColourTargetSchema, GradeSchema } from "../src/types/colour";

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
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    filter,
    "-t",
    String(seconds),
    "-vf",
    "format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "4",
    ...TAGS,
    file,
  );
  return file;
}
function cli(script: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts", script), ...args],
    {
      encoding: "utf8",
      timeout: 600_000,
      cwd: repo,
      env: { ...process.env, AGENTBROS_EVENTS: "off" },
    },
  );
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout + result.stderr);
  const envelope = JSON.parse(lines[0]!) as {
    ok: boolean;
    outputs?: string[];
    metadata?: Record<string, unknown>;
    message?: string;
  };
  assert.equal(envelope.ok, true, envelope.message ?? result.stderr);
  return envelope;
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("grade contract: one number per channel expands, unknown keys are refused, LUT paths resolve", () => {
  const grade = GradeSchema.parse({ lift: 0.02, gain: [1, 1.1, 0.9], saturation: 0.9 });
  const lutDir = mkdtempSync(path.join(work, "lut-"));
  writeFileSync(
    path.join(lutDir, "look.cube"),
    "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n",
  );
  const normalised = normaliseGrade(
    { ...grade, luts: [{ path: "look.cube", position: "look", strength: 1 }] },
    path.join(lutDir, "g.json"),
  );
  assert.deepEqual(normalised.lift, [0.02, 0.02, 0.02]);
  assert.deepEqual(normalised.gain, [1, 1.1, 0.9]);
  assert.equal((normalised.luts as { path: string }[])[0]!.path, path.join(lutDir, "look.cube"));
  assert.equal(GradeSchema.safeParse({ lfit: 0.1 }).success, false);
  assert.equal(
    GradeSchema.safeParse({
      windows: [{ name: "w", mask: { kind: "shape", box: [0.1, 0.1, 0.2, 0.2] }, grade: { exposure: 1 } }],
    }).success,
    true,
  );
});

test("timelines: overlaps are refused and gaps are filled with the base grade", () => {
  const file = path.join(work, "timeline.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      segments: [
        { start: 0, end: 2, grade: "a.json" },
        { start: 1.5, end: 3, grade: "b.json" },
      ],
    }),
  );
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
    z.object({
      ok: z.literal(true),
      deltaE2000: z.array(z.number()),
      expected: z.array(z.number()),
      redAngleDeg: z.number(),
    }),
  );
  result.deltaE2000.forEach((value, i) =>
    assert.ok(Math.abs(value - result.expected[i]!) < 1e-3, `pair ${i}: ${value}`),
  );
  assert.ok(Math.abs(result.redAngleDeg - 102.9) < 0.2);
});

test("scopes: letterboxed bars are cropped, every scope and the numbers are written, deterministically", worker, () => {
  const bars = encode(path.join(work, "bars-letterbox.mp4"), "smptehdbars=s=640x272:r=25,pad=640:360:0:44:black");
  const runs = ["a", "b"].map((name) =>
    cli("colour-scopes.ts", ["--input", bars, "--frames", "2", "--output", path.join(work, `scopes-${name}`)]),
  );
  const meta = runs[0]!.metadata as {
    activePicture: { cropped: boolean; y: number; height: number };
    files: Record<string, string>;
    clipping: unknown;
  };
  assert.equal(meta.activePicture.cropped, true);
  assert.ok(
    Math.abs(meta.activePicture.y - 44) <= 2 && Math.abs(meta.activePicture.height - 272) <= 4,
    JSON.stringify(meta.activePicture),
  );
  for (const name of [
    "sheet",
    "waveform-luma",
    "waveform-rgb",
    "parade",
    "vectorscope",
    "vectorscope-2x",
    "histogram",
    "cie",
    "false-colour",
  ])
    assert.ok(existsSync(meta.files[name]!), name);
  const stats = JSON.parse(readFileSync(path.join(work, "scopes-a", "stats.json"), "utf8")) as {
    stats: { legal: { yBelowPct: number }; luma: unknown };
  };
  assert.ok(stats.stats.legal.yBelowPct > 0, "SMPTE HD bars carry a -2% sub-black PLUGE step");
  assert.equal(sha(path.join(work, "scopes-a", "sheet.png")), sha(path.join(work, "scopes-b", "sheet.png")));
  assert.equal(
    readFileSync(path.join(work, "scopes-a", "stats.json"), "utf8").replace(/scopes-a/g, "x"),
    readFileSync(path.join(work, "scopes-b", "stats.json"), "utf8").replace(/scopes-b/g, "x"),
  );
});

test(
  "compare, match and grade: a blue-tinted gradient is diagnosed cooler and matched back with evidence",
  worker,
  () => {
    const gradient = "gradients=s=480x270:c0=0x302010:c1=0xe0d0b0:x0=0:y0=0:x1=480:y1=270:r=25";
    const source = encode(path.join(work, "gradient.mp4"), gradient);
    const tinted = encode(path.join(work, "gradient-cool.mp4"), `${gradient},colorchannelmixer=rr=0.88:bb=1.12`);
    const compared = cli("colour-compare.ts", [
      "--input",
      tinted,
      "--reference",
      source,
      "--frames",
      "2",
      "--output",
      path.join(work, "cmp"),
    ]);
    const summary = String(compared.metadata!.summary);
    assert.match(summary, /cooler/);
    const before = (compared.metadata!.zones as { meanDeltaE2000: number }).meanDeltaE2000;
    const gradeFile = path.join(work, "match.grade.json");
    cli("colour-match.ts", ["--input", tinted, "--reference", source, "--frames", "2", "--output", gradeFile]);
    const grade = GradeSchema.parse(JSON.parse(readFileSync(gradeFile, "utf8")));
    assert.equal(grade.matchedTo?.method, "stats");
    const graded = path.join(work, "gradient-graded.mp4");
    cli("colour-grade.ts", [
      "--grade",
      gradeFile,
      "--input",
      tinted,
      "--output",
      graded,
      "--export-cube",
      path.join(work, "match.cube"),
      "--lut-size",
      "17",
    ]);
    assert.match(
      readFileSync(path.join(work, "match.cube"), "utf8"),
      /LUT_3D_SIZE 17\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0/,
    );
    const after = cli("colour-compare.ts", [
      "--input",
      graded,
      "--reference",
      source,
      "--frames",
      "2",
      "--output",
      path.join(work, "cmp-after"),
    ]);
    const afterDe = (after.metadata!.zones as { meanDeltaE2000: number }).meanDeltaE2000;
    assert.ok(afterDe < before / 2, `zone dE2000 ${before} -> ${afterDe}`);
    assert.throws(
      () => cli("colour-match.ts", ["--input", tinted, "--reference", source, "--output", gradeFile]),
      /exists/,
    );
  },
);

test("identity grade round trip through ffmpeg stays below one CIEDE2000 unit", worker, () => {
  const bars = encode(path.join(work, "bars.mp4"), "smptehdbars=s=640x360:r=25");
  const identity = path.join(work, "identity.json");
  writeFileSync(identity, "{}\n");
  const out = path.join(work, "bars-identity.mp4");
  cli("colour-grade.ts", ["--grade", identity, "--input", bars, "--output", out]);
  const compared = cli("colour-compare.ts", [
    "--input",
    out,
    "--reference",
    bars,
    "--frames",
    "1",
    "--crop",
    "none",
    "--reference-crop",
    "none",
    "--output",
    path.join(work, "cmp-id"),
  ]);
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
  writeFileSync(
    gradeFile,
    JSON.stringify({
      windows: [
        {
          name: "patch",
          mask: { kind: "shape", shape: "rectangle", track: "patch.track.json", softness: 0.05 },
          grade: { exposure: 1 },
        },
      ],
    }),
  );
  const graded = path.join(work, "moving-window.mp4");
  cli("colour-grade.ts", ["--grade", gradeFile, "--input", clip, "--output", graded]);
  const frame = (file: string) => {
    const result = spawnSync(
      "ffmpeg",
      ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
      { maxBuffer: 1 << 24 },
    );
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
  const b = encode(
    path.join(work, "shot-b.mp4"),
    "testsrc2=s=320x180:r=25,colorchannelmixer=rr=0.7:bb=1.2,eq=brightness=-0.08",
    1,
  );
  const edit = path.join(work, "edit.mp4");
  ffmpeg(
    "-i",
    a,
    "-i",
    b,
    "-filter_complex",
    "[0][1]concat=n=2:v=1:a=0,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "4",
    ...TAGS,
    edit,
  );
  const result = cli("colour-shots.ts", ["--input", edit, "--output", path.join(work, "shots"), "--solve"]);
  const shots = result.metadata!.shots as { label: string; outOfTolerance: boolean; start: number }[];
  assert.equal(shots.length, 2, JSON.stringify(shots));
  assert.ok(Math.abs(shots[1]!.start - 1) < 0.25);
  assert.equal(shots[1]!.outOfTolerance, true);
  assert.ok(existsSync(path.join(work, "shots", "timeline.json")));
});

test("gate and skin-aware match: a yellow skin push fails; matching the world spares the face", worker, () => {
  const dir = mkdtempSync(path.join(work, "skin-"));
  const still = (name: string, background: string, skin: string) => {
    const file = path.join(dir, name);
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      `color=c=${background}:s=320x180,drawbox=x=120:y=45:w=80:h=90:color=${skin}:t=fill,noise=alls=10:allf=t`,
      "-frames:v",
      "1",
      file,
    );
    return file;
  };
  // A generated frame: azure-blue room, ordinary warm skin. The reference: teal room, darker and muted skin.
  const input = still("input.png", "0x3c5f96", "0xc08a70");
  const reference = still("reference.png", "0x1e6464", "0x7a6458");
  const region = ["--skin-region", "125,50,70,80"];

  const yellow = path.join(dir, "yellow.grade.json");
  writeFileSync(yellow, JSON.stringify({ gain: [1.1, 1.07, 0.82], saturation: 1.45 }));
  cli("colour-grade.ts", ["--grade", yellow, "--input", input, "--output", path.join(dir, "yellow.png")]);
  const bad = cli("colour-check.ts", [
    "--input",
    path.join(dir, "yellow.png"),
    "--source",
    input,
    "--output",
    path.join(dir, "check-yellow"),
    ...region,
  ]);
  assert.equal(bad.metadata!.status, "fail");
  const failed = (bad.metadata!.failed as string[]).join(" ");
  assert.match(failed, /skin (chroma|b\*)/);
  assert.ok(existsSync(path.join(dir, "check-yellow", "check.png")));

  const referenceSkin = (mode: string) => {
    const out = path.join(dir, `${mode}.grade.json`);
    const result = cli("colour-match.ts", [
      "--input",
      input,
      "--reference",
      reference,
      "--output",
      out,
      "--skin",
      mode,
      ...region,
      "--reference-skin-region",
      "125,50,70,80",
    ]);
    const report = JSON.parse(readFileSync(path.join(dir, `${mode}.grade-match`, "match.json"), "utf8")) as {
      gate: { status: string; checks: { id: string; value: number }[] };
    };
    return { result, report, skinDe: report.gate.checks.find((c) => c.id === "reference.skin")!.value };
  };
  const global = referenceSkin("off");
  const aware = referenceSkin("match");
  assert.ok(
    aware.skinDe < global.skinDe,
    `skin-aware match lands skin nearer the reference (${aware.skinDe} vs ${global.skinDe})`,
  );
  assert.ok(aware.skinDe < 6, `skin within the gate's warn limit, got ${aware.skinDe}`);
  assert.notEqual(aware.report.gate.status, "fail");
  assert.ok((aware.result.metadata!.stages as string[]).some((s) => s.startsWith("skin secondary")));
});

test("looks: every preset applies, holds skin and reports a gate; the list explains each one", worker, () => {
  const listed = cli("colour-looks.ts", ["--list"]);
  const looks = listed.metadata!.looks as { id: string; intent: string; risks: string[] }[];
  assert.ok(looks.length >= 10);
  for (const look of looks) assert.ok(look.intent && look.risks.length, look.id);
  const dir = mkdtempSync(path.join(work, "looks-"));
  const input = path.join(dir, "in.png");
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=0x3c5f96:s=320x180,drawbox=x=120:y=45:w=80:h=90:color=0xc08a70:t=fill,noise=alls=10:allf=t",
    "-frames:v",
    "1",
    input,
  );
  const run = () =>
    cli("colour-looks.ts", ["--input", input, "--output", dir, "--skin-region", "125,50,70,80", "--force"]);
  const first = run();
  const summary = first.metadata!.looks as { id: string; gate: string; grade: string }[];
  assert.equal(summary.length, 6);
  for (const look of summary) {
    assert.notEqual(look.gate, "fail", `${look.id} keeps skin within its policy`);
    GradeSchema.parse(JSON.parse(readFileSync(look.grade, "utf8")));
  }
  const grid = path.join(dir, "looks.png");
  const hash = sha(grid);
  run();
  assert.equal(sha(grid), hash, "the grid is deterministic");
});

test(
  "target: a reference becomes per-shot profiles; the same clip passes, an oversaturated grade fails",
  worker,
  () => {
    const dir = mkdtempSync(path.join(work, "target-"));
    const warm = encode(path.join(dir, "warm.mp4"), "gradients=s=320x180:c0=0x2a1a10:c1=0xe8c8a0:r=25", 1.5);
    const cool = encode(path.join(dir, "cool.mp4"), "gradients=s=320x180:c0=0x0a1a2a:c1=0x90b8e0:r=25", 1.5);
    const reference = path.join(dir, "reference.mp4");
    ffmpeg(
      "-i",
      warm,
      "-i",
      cool,
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1[v]",
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-crf",
      "4",
      ...TAGS,
      reference,
    );
    const out = path.join(dir, "target");
    const run = () => cli("colour-target.ts", ["--input", reference, "--output", out, "--force"]);
    run();
    const targetFile = path.join(out, "target.json");
    const target = ColourTargetSchema.parse(JSON.parse(readFileSync(targetFile, "utf8")));
    assert.equal(target.shots.length, 2, "the cut between the warm and the cool shot is found");
    assert.ok(target.shots[0]!.profile.colour.warmth > target.shots[1]!.profile.colour.warmth);
    assert.equal(target.shots[0]!.profile.palette.length, 5);
    const hash = sha(targetFile);
    run();
    assert.equal(sha(targetFile), hash, "profiles and palettes are deterministic");
    const same = cli("colour-check.ts", [
      "--input",
      reference,
      "--target",
      targetFile,
      "--output",
      path.join(dir, "same"),
    ]);
    assert.equal(same.metadata!.status, "pass", JSON.stringify(same.metadata!.shots));
    const loud = path.join(dir, "loud.mp4");
    ffmpeg("-i", reference, "-vf", "eq=saturation=2.6:contrast=1.3", "-c:v", "libx264", "-crf", "4", ...TAGS, loud);
    const check = cli("colour-check.ts", ["--input", loud, "--target", targetFile, "--output", path.join(dir, "loud")]);
    assert.equal(check.metadata!.status, "fail");
    assert.ok(
      (check.metadata!.failed as string[]).some((text) => /chroma/.test(text)),
      String(check.metadata!.failed),
    );
  },
);

test("mood plan: a higher arousal raises saturation within bounds, gated, as a per-shot timeline", worker, () => {
  const dir = mkdtempSync(path.join(work, "mood-"));
  const clip = encode(path.join(dir, "clip.mp4"), "gradients=s=320x180:c0=0x203040:c1=0xa08060:r=25", 2);
  const out = path.join(dir, "plan");
  const result = cli("colour-target.ts", ["--input", clip, "--output", out, "--single", "--mood", "0:0.2,0.8"]);
  const shots = result.metadata!.shots as { mood: { arousal: number }; gate: string }[];
  const measured = (
    JSON.parse(readFileSync(path.join(out, "target.json"), "utf8")) as { shots: { wantedMood: unknown }[] }
  ).shots[0]!;
  assert.deepEqual(measured.wantedMood, { valence: 0.2, arousal: 0.8 });
  assert.notEqual(shots[0]!.gate, "fail");
  const grade = GradeSchema.parse(JSON.parse(readFileSync(path.join(out, "grades", "shot-01.json"), "utf8")));
  assert.ok(grade.saturation! > 1 && grade.saturation! <= 1.25, `bounded saturation, got ${grade.saturation}`);
  assert.ok(existsSync(path.join(out, "timeline.json")));
});

test(
  "looks by mood and imported LUTs: nearest looks first; a LUT needs its licence and runs as a held look",
  worker,
  () => {
    const calm = looksForMood({ valence: 0.7, arousal: -0.3 }, 3).map((look) => look.id);
    assert.ok(calm.includes("beauty-soft"), calm.join(","));
    const dir = mkdtempSync(path.join(work, "lut-"));
    const hald = path.join(dir, "warm.png");
    ffmpeg("-f", "lavfi", "-i", "haldclutsrc=8", "-frames:v", "1", "-vf", "colorchannelmixer=rr=1.08:bb=0.85", hald);
    const luts = path.join(dir, "luts");
    const refused = spawnSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "scripts/colour-lut.ts"),
        "--dir",
        luts,
        "--add",
        hald,
      ],
      { encoding: "utf8", cwd: repo, env: { ...process.env, AGENTBROS_EVENTS: "off" } },
    );
    assert.match(refused.stdout, /unknown licence is not imported/);
    const added = cli("colour-lut.ts", [
      "--dir",
      luts,
      "--add",
      hald,
      "--id",
      "warm",
      "--licence",
      "own",
      "--source",
      "test",
    ]);
    assert.equal(added.metadata!.size, 64);
    assert.ok((added.metadata!.moodShift as { valence: number }).valence > 0, "a warm LUT lifts valence");
    const looks = cli("colour-looks.ts", [
      "--card",
      "--output",
      path.join(dir, "card"),
      "--lut",
      path.join(luts, "warm.cube"),
    ]);
    const summary = looks.metadata!.looks as { id: string; gate: string; lut?: { licence: string } }[];
    assert.equal(summary[0]!.id, "lut-warm");
    assert.equal(summary[0]!.lut?.licence, "own");
    assert.notEqual(summary[0]!.gate, "fail");
  },
);

test("the Looks & colour library page is generated from the looks", async () => {
  const doc = path.join(repo, "docs/library/looks.md");
  assert.equal(readFileSync(doc, "utf8"), await formatMarkdown(looksDoc(), doc), "run pnpm colour:looks --write-doc");
  for (const look of LOOKS) assert.ok(readFileSync(doc, "utf8").includes(`\`${look.id}\``), look.id);
});
