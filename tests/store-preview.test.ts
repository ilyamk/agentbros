import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { conformArgs, factsFromProbe, inputBlockers, specFor, verifyPreview } from "../src/lib/store/preview";

type Stream = Record<string, unknown>;
const video = (over: Stream = {}): Stream => ({
  codec_type: "video",
  codec_name: "h264",
  profile: "High",
  level: 40,
  width: 886,
  height: 1920,
  avg_frame_rate: "30/1",
  r_frame_rate: "30/1",
  pix_fmt: "yuv420p",
  sample_aspect_ratio: "1:1",
  bit_rate: "11000000",
  duration: "20.000000",
  ...over,
});
const audio = (over: Stream = {}): Stream => ({
  codec_type: "audio",
  codec_name: "aac",
  channels: 2,
  sample_rate: "48000",
  bit_rate: "256000",
  ...over,
});
const probe = (streams: Stream[], format: Stream = {}) =>
  factsFromProbe({ streams, format: { duration: "20.021333", size: "28000000", ...format } });
const codes = (findings: { code: string; severity: string }[], severity = "error") =>
  findings.filter((finding) => finding.severity === severity).map((finding) => finding.code);

const iphone = specFor("apple", "iphone");

test("specFor needs a class for apple and refuses one for google", () => {
  assert.throws(() => specFor("apple"), /needs --class/);
  assert.throws(() => specFor("apple", "watch"), /Unknown --class/);
  assert.throws(() => specFor("google", "iphone"), /only to --store apple/);
  assert.deepEqual(specFor("apple", "ipad").sizes, [
    { width: 1200, height: 1600 },
    { width: 1600, height: 1200 },
  ]);
  assert.deepEqual(specFor("apple", "mac").sizes, [{ width: 1920, height: 1080 }]);
});

test("a conforming probe passes, judged on the picture's duration rather than AAC padding", () => {
  const facts = probe([video(), audio()]);
  assert.equal(facts.video.durationSec, 20);
  assert.deepEqual(verifyPreview(facts, iphone), []);
  assert.deepEqual(
    codes(verifyPreview(probe([video({ duration: "30.000000" }), audio()], { duration: "30.023" }), iphone)),
    [],
  );
});

test("wrong size, length, fps, audio and file size are each an error", () => {
  assert.deepEqual(codes(inputBlockers(probe([video({ width: 1080 })]), iphone)), ["SIZE"]);
  assert.match(inputBlockers(probe([video({ width: 1080 })]), iphone)[0]!.fix!, /886x1920/);
  assert.deepEqual(codes(inputBlockers(probe([video({ width: 1920, height: 886 })]), iphone)), []);
  assert.deepEqual(codes(inputBlockers(probe([video({ duration: "14.5" })]), iphone)), ["DURATION"]);
  assert.deepEqual(codes(inputBlockers(probe([video({ duration: "31" })]), iphone)), ["DURATION"]);
  assert.deepEqual(codes(inputBlockers(probe([video({ sample_aspect_ratio: "4:3" })]), iphone)), ["PIXEL_ASPECT"]);
  assert.deepEqual(codes(verifyPreview(probe([video({ avg_frame_rate: "60/1" }), audio()]), iphone)), ["FPS"]);
  assert.deepEqual(codes(verifyPreview(probe([video()]), iphone)), ["AUDIO_MISSING"]);
  const google = specFor("google");
  assert.deepEqual(
    codes(verifyPreview(probe([video({ width: 1080 })]), google)),
    [],
    "a silent Play video is not an error",
  );
  assert.deepEqual(codes(verifyPreview(probe([video({ width: 1080 })]), google), "warning"), ["AUDIO_MISSING"]);
  assert.doesNotMatch(
    verifyPreview(probe([video({ width: 1080 })]), google).find((finding) => finding.code === "AUDIO_MISSING")!.message,
    /App Store/,
  );
  assert.deepEqual(
    codes(verifyPreview(probe([video(), audio({ channels: 1, sample_rate: "22050", codec_name: "mp3" })]), iphone)),
    ["AUDIO_CODEC", "AUDIO_CHANNELS", "AUDIO_RATE"],
  );
  assert.deepEqual(codes(verifyPreview(probe([video(), audio(), audio()]), iphone)), ["AUDIO_STREAMS"]);
  assert.deepEqual(codes(verifyPreview(probe([video(), audio()], { size: String(501 * 1024 * 1024) }), iphone)), [
    "FILE_SIZE",
  ]);
});

test("measured bitrates and profile are warnings, not errors", () => {
  const findings = verifyPreview(
    probe([video({ bit_rate: "3000000", profile: "Main" }), audio({ bit_rate: "2000" })]),
    iphone,
  );
  assert.deepEqual(codes(findings), []);
  assert.deepEqual(codes(findings, "warning"), ["VIDEO_PROFILE", "VIDEO_BITRATE", "AUDIO_BITRATE"]);
});

test("google takes 9:16 or 16:9 with no minimum, and warns past 30 s or 30 fps", () => {
  const google = specFor("google");
  const facts = probe([video({ width: 1080, duration: "8", avg_frame_rate: "60/1" }), audio()]);
  assert.deepEqual(codes(verifyPreview(facts, google)), []);
  assert.deepEqual(codes(verifyPreview(probe([video({ width: 1080, duration: "45" }), audio()]), google), "warning"), [
    "DURATION",
  ]);
  assert.deepEqual(codes(inputBlockers(probe([video()]), google)), ["SIZE"]);
  assert.equal(conformArgs("in.mp4", "out.mp4", facts, google).reencodeReasons.length, 0);
});

test("conformArgs copies a matching picture, adds silence when there is no audio, and re-encodes only for a reason", () => {
  const silent = conformArgs("in.mp4", "out.mp4", probe([video()]), iphone);
  assert.equal(silent.addedSilence, true);
  assert.deepEqual(silent.reencodeReasons, []);
  const joined = silent.args.join(" ");
  assert.match(joined, /-f lavfi -t 20\.000000 -i anullsrc=r=48000:cl=stereo/);
  assert.match(joined, /-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 256k -ar 48000 -ac 2 -t 20\.000000/);
  assert.doesNotMatch(joined, /scale|pad/);

  const sixty = conformArgs(
    "in.mp4",
    "out.mp4",
    probe([video({ avg_frame_rate: "60/1", level: 42 }), audio({ channels: 6 })]),
    iphone,
  );
  assert.equal(sixty.addedSilence, false);
  assert.deepEqual(sixty.reencodeReasons, ["level 42 is above 4.0", "60.00 fps is above 30"]);
  assert.match(
    sixty.args.join(" "),
    /-map 0:v:0 -map 0:a:0 -c:v libx264 -profile:v high -level:v 4\.0 -pix_fmt yuv420p -b:v 11000k .* -r 30 .*-ac 2/,
  );
  assert.deepEqual(conformArgs("in.mp4", "out.mp4", probe([video(), audio()]), iphone, true).reencodeReasons, [
    "--reencode-video",
  ]);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test(
  "store:conform adds a silent stereo track to a silent 886x1920 film and refuses a wrong size",
  { skip: !hasFfmpeg && "ffmpeg not installed" },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-conform-"));
    try {
      const make = (file: string, size: string) => {
        const result = spawnSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=blue:s=${size}:r=30:d=15`,
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          file,
        ]);
        assert.equal(result.status, 0, String(result.stderr));
      };
      const run = (...args: string[]) => {
        const child = spawnSync(
          process.execPath,
          [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/store-conform.ts"), ...args],
          { encoding: "utf8", timeout: 60_000 },
        );
        assert.equal(child.stdout.trim().split("\n").length, 1);
        return { status: child.status, result: JSON.parse(child.stdout) };
      };
      const film = path.join(dir, "film.mp4");
      const out = path.join(dir, "appstore.mp4");
      make(film, "886x1920");
      const conformed = run("--input", film, "--store", "apple", "--class", "iphone", "--output", out);
      assert.equal(conformed.status, 0, JSON.stringify(conformed.result));
      assert.equal(conformed.result.metadata.pictureCopied, true);
      assert.equal(conformed.result.metadata.addedSilence, true);
      assert.deepEqual(conformed.result.metadata.facts.audio, {
        ...conformed.result.metadata.facts.audio,
        codec: "aac",
        channels: 2,
        sampleRate: 48000,
      });
      assert.equal(run("--input", out, "--store", "apple", "--class", "iphone").status, 0);

      const wrong = path.join(dir, "wrong.mp4");
      make(wrong, "1080x1920");
      const refused = run(
        "--input",
        wrong,
        "--store",
        "apple",
        "--class",
        "iphone",
        "--output",
        path.join(dir, "x.mp4"),
      );
      assert.equal(refused.status, 1);
      assert.equal(refused.result.error, "VALIDATION");
      assert.match(refused.result.message, /never rescales/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
