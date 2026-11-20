import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
const entry = path.join(repo, "tests/fixtures/motion-check/index.tsx");
const skip = process.env.RUN_RENDER_TESTS !== "1";

type Report = {
  counters: Record<string, number | null>;
  findings: Array<{ code: string; frame: number; message: string; fix: string }>;
  frames: number;
  skipped: Record<string, string>;
  allowed: Array<{ matched: number }>;
  unusedAllow: unknown[];
  readability: { findings: Array<{ code: string; frame: number; text: string }>; contrastSamples: number };
};

function check(root: string, composition: string, ...flags: string[]) {
  const child = spawnSync(
    process.execPath,
    [
      tsx,
      path.join(repo, "scripts/motion-check.ts"),
      "--entry",
      entry,
      "--composition",
      composition,
      "--public-dir",
      path.join(root, "public"),
      ...flags,
    ],
    {
      // From the repository, to share its webpack cache: a cold bundle takes about 40 seconds per test.
      cwd: repo,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must be one JSON line: ${child.stdout}\n${child.stderr}`);
  return {
    status: child.status,
    stderr: child.stderr,
    result: JSON.parse(lines[0]!) as { ok: boolean; error?: string; metadata: Report },
  };
}

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "motion-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public"));
  return root;
}

const nonZero = (report: Report) =>
  Object.entries(report.counters)
    .filter(([, value]) => value)
    .map(([name]) => name);

test(
  "readability checks Chromium pixels, short holds and phone scale without failing the motion gate",
  {
    skip,
    timeout: 120000,
  },
  (t) => {
    const { status, result } = check(workspace(t), "ReadabilityFixture", "--frames", "2");
    assert.equal(status, 0, JSON.stringify(result));
    assert.ok(result.metadata.readability.contrastSamples > 0);
    const warnings = result.metadata.readability.findings;
    assert.ok(warnings.some(({ code, text }) => code === "LOW_CONTRAST" && text === "Низкий контраст"));
    assert.ok(warnings.some(({ code, text }) => code === "TEXT_TOO_SMALL_ON_PHONE" && text === "Tiny label"));
    assert.ok(warnings.some(({ code, text }) => code === "TEXT_VISIBLE_TOO_BRIEFLY" && text === "A message to read"));
    assert.ok(!warnings.some(({ code, text }) => code === "LOW_CONTRAST" && text === "Readable fade"));
  },
);

test(
  "a clean composition reads zero, including its crossfade, mask and layered text",
  { skip, timeout: 120000 },
  (t) => {
    const { status, stderr, result } = check(workspace(t), "Clean");
    assert.equal(status, 0, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.deepEqual(nonZero(result.metadata), []);
    assert.ok(result.metadata.frames >= 7);
    assert.equal(result.metadata.counters.fallbackFonts, 0);
    assert.equal(result.metadata.counters.loopSeam, null);
    assert.match(stderr, /textOverlap\s+0/);
  },
);

const failures: Array<[composition: string, counter: string, code: string, flags: string[], mention: RegExp]> = [
  ["Overlap", "textOverlap", "TEXT_OVERLAP", [], /First line of text.*Second line of text/],
  ["OffStage", "textOffStage", "TEXT_OFF_STAGE", [], /past the right/],
  ["Region", "textOutsideRegion", "TEXT_OUTSIDE_REGION", [], /region "headline"/],
  ["SafeZone", "textOutsideSafeZone", "TEXT_OUTSIDE_SAFE_ZONE", ["--safe-zone", "vertical"], /past the top/],
  ["Random", "nonDeterministic", "NON_DETERMINISTIC", [], /differs/],
  ["Fallback", "fallbackFonts", "FALLBACK_FONT", [], /asks for "LatinOnly"/],
  ["FadedFinal", "fadedFinal", "FADED_FINAL", [], /fades out/],
  ["BrokenSeam", "loopSeam", "LOOP_SEAM", ["--loop-frames", "20"], /Frame 0 and frame 20 differ/],
  ["BlackFrame", "deadFrames", "DEAD_FRAME", [], /entirely black/],
  ["ConsoleError", "consoleErrors", "CONSOLE_ERROR", [], /Deliberate fixture console error/],
  ["Throws", "runtimeErrors", "RUNTIME_ERROR", [], /Deliberate fixture failure/],
  ["SlopEntry", "simultaneousEntry", "SIMULTANEOUS_ENTRY", [], /3 elements start entering on frame 5/],
  ["SlopCentred", "textCentredAlways", "TEXT_CENTRED_ALWAYS", [], /centre line/],
  ["SlopEmoji", "emojiText", "EMOJI_TEXT", [], /Launch/],
  ["SlopPalette", "slopPalette", "SLOP_PALETTE", [], /purple-blue gradient|frosted-glass/],
];

for (const [composition, counter, code, flags, mention] of failures)
  test(`${composition} trips only ${counter}, and says how to fix it`, { skip, timeout: 120000 }, (t) => {
    const { status, result } = check(workspace(t), composition, ...flags);
    assert.equal(status, 1, JSON.stringify(result));
    assert.equal(result.ok, false);
    assert.equal(result.error, "VALIDATION");
    assert.deepEqual(nonZero(result.metadata), [counter], JSON.stringify(result.metadata.findings));
    const finding = result.metadata.findings.find((item) => item.code === code);
    assert.ok(finding, JSON.stringify(result.metadata.findings));
    assert.match(finding.message, mention);
    assert.ok(finding.fix.length > 20);
  });

test(
  "a strobe over consecutive frames trips only flashRisk; a sampled walk skips the flash check",
  { skip, timeout: 120000 },
  (t) => {
    const root = workspace(t);
    const { status, result } = check(root, "Strobe", "--frames", "0-29");
    assert.equal(status, 1, JSON.stringify(result));
    assert.deepEqual(nonZero(result.metadata), ["flashRisk"], JSON.stringify(result.metadata.findings));
    assert.match(
      result.metadata.findings.find((item) => item.code === "FLASH_RISK")!.message,
      /general flashes at 0-1 s/,
    );
    const sampled = check(root, "Strobe").result;
    assert.equal(sampled.metadata.counters.flashRisk, null);
    assert.match(sampled.metadata.skipped.flashRisk!, /--render/);
  },
);

test("a walk that stops early reports what it could not check as null, not zero", { skip, timeout: 120000 }, (t) => {
  const { result } = check(workspace(t), "Throws", "--loop-frames", "20");
  assert.equal(result.metadata.counters.fadedFinal, null);
  assert.equal(result.metadata.counters.loopSeam, null);
  assert.equal(result.metadata.counters.nonDeterministic, null);
  assert.equal(result.metadata.counters.deadFrames, 0);
  assert.ok(result.metadata.skipped.fadedFinal);
});

test("a frame that only renders after earlier frames counts as non-deterministic", { skip, timeout: 120000 }, (t) => {
  const { status, result } = check(workspace(t), "OnlyInSequence");
  assert.equal(status, 1, JSON.stringify(result));
  assert.ok(result.metadata.counters.nonDeterministic! > 0, JSON.stringify(result.metadata.findings));
  assert.match(
    result.metadata.findings.find((item) => item.code === "NON_DETERMINISTIC")!.message,
    /not when opened directly/,
  );
});

test("a loop that closes passes the seam check", { skip, timeout: 120000 }, (t) => {
  const { status, result } = check(workspace(t), "LoopGood", "--loop-frames", "20");
  assert.equal(status, 0, JSON.stringify(result));
  assert.equal(result.metadata.counters.loopSeam, 0);
});

test("--allow clears an intended exception and reports stale rules", { skip, timeout: 120000 }, (t) => {
  const allow = JSON.stringify([
    { code: "FADED_FINAL", reason: "End card fades by design" },
    { code: "TEXT_OVERLAP", text: "nothing like this", reason: "Stale" },
  ]);
  const { status, result } = check(workspace(t), "FadedFinal", "--allow", allow);
  assert.equal(status, 0, JSON.stringify(result));
  assert.equal(result.metadata.counters.fadedFinal, 0);
  assert.equal(result.metadata.allowed[0]!.matched, 1);
  assert.equal(result.metadata.unusedAllow.length, 1);
});

test("--render reports a pixel aspect ratio, codec and duration mismatch", { skip, timeout: 120000 }, (t) => {
  const root = workspace(t);
  const file = path.join(root, "wrong.mp4");
  const made = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=30:d=0.5",
      "-vf",
      "setsar=2/1",
      "-c:v",
      "mpeg4",
      file,
    ],
    { encoding: "utf8" },
  );
  assert.equal(made.status, 0, made.stderr);
  const { status, result } = check(root, "LoopGood", "--render", file);
  assert.equal(status, 1, JSON.stringify(result));
  assert.deepEqual(nonZero(result.metadata), ["renderFile"]);
  assert.deepEqual(result.metadata.findings.map((item) => item.code).sort(), [
    "RENDER_CODEC",
    "RENDER_DURATION",
    "RENDER_PIXEL_ASPECT",
  ]);
});

test(
  "library blocks that overflow by design declare it: their documented use passes, listed under intendedOverflow",
  { skip, timeout: 600000 },
  () => {
    const library = (entry: string, composition: string, frames: string) => {
      const child = spawnSync(
        process.execPath,
        [
          tsx,
          path.join(repo, "scripts/motion-check.ts"),
          "--entry",
          path.join(repo, entry),
          "--composition",
          composition,
          "--frames",
          frames,
          "--safe-zone",
          "vertical",
        ],
        {
          cwd: repo,
          encoding: "utf8",
          env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
        ok: boolean;
        metadata: Report & { intendedOverflow: { code: string; reason: string; frame: number; lastFrame: number }[] };
      };
    };
    const giant = library("src/motion/library/typography/preview.tsx", "Lib-giant-word-pull-out-V", "0-20");
    assert.deepEqual(
      [giant.metadata.counters.textOffStage, giant.metadata.counters.textOutsideSafeZone],
      [0, 0],
      JSON.stringify(giant.metadata.findings),
    );
    assert.ok(
      giant.metadata.intendedOverflow.some(
        (row) => row.code === "TEXT_OFF_STAGE" && row.frame === 0 && /giant-word-pull-out/.test(row.reason),
      ),
    );
    assert.ok(
      giant.metadata.intendedOverflow.every((row) => row.lastFrame < 17),
      "declared only until the word settles",
    );
    const punch = library("src/motion/library/camera/preview.tsx", "Lib-ui-punch-reframe-V", "0-103:3");
    assert.deepEqual(
      [punch.metadata.counters.textOffStage, punch.metadata.counters.textOutsideSafeZone],
      [0, 0],
      JSON.stringify(punch.metadata.findings),
    );
    assert.ok(punch.metadata.intendedOverflow.length > 0);
    const hero = library("src/motion/library/typography/preview.tsx", "Lib-type-hero-word-V", "0-107:6");
    assert.equal(hero.metadata.counters.textOutsideSafeZone, 0, "the default fit stays inside the vertical safe zone");
  },
);
