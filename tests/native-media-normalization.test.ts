import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  nativeDecodedFrameAt,
  nativeDecodedClockFromFrames,
  validateNativeDecodedClock,
  nativeAudioClock,
  nativePlayableSamples,
  runNativeNormalizationTool,
  NativeNormalizationReceiptSchema,
} from "../src/lib/backends/native-media-normalization";
const clock = { timebase: { num: 1, den: 30000 }, pts: [0, 1001, 2002, 6006, 7007], terminalTick: 10010 };
test("original29.97/VFR clock maps boundaries without quantizing short frames to proxy fps", () => {
  for (const [time, expected] of [
    [0, 0],
    [1001 / 30000, 1],
    [2002 / 30000, 2],
    [6005 / 30000, 2],
    [6006 / 30000, 3],
    [7007 / 30000, 4],
  ] as const)
    assert.equal(nativeDecodedFrameAt(clock, time), expected);
  for (const time of [-1, NaN, 10010 / 30000]) assert.throws(() => nativeDecodedFrameAt(clock, time));
});
test("decoded clocks reject offset, duplicate, reordered and ambiguous terminal extents", () => {
  for (const patch of [
    { pts: [1, 1001] },
    { pts: [0, 0] },
    { pts: [0, 2002, 1001] },
    { terminalTick: 7007 },
    { terminalTick: 30000 * 61 },
  ])
    assert.throws(() => validateNativeDecodedClock({ ...clock, ...patch }));
});
test("decoded interval evidence refuses gaps/overlaps despite plausible PTS and duration metadata", () => {
  const frames = [
    { pts: 0, duration: 2 },
    { pts: 2, duration: 3 },
  ];
  assert.equal(nativeDecodedClockFromFrames(frames, { num: 1, den: 30 }, 5).terminalTick, 5);
  for (const duration of [1, 3])
    assert.throws(() =>
      nativeDecodedClockFromFrames(
        [
          { pts: 0, duration },
          { pts: 2, duration: 3 },
        ],
        { num: 1, den: 30 },
        5,
      ),
    );
  assert.throws(() => nativeDecodedClockFromFrames(frames, { num: 1, den: 30 }, 6));
});
test("physical contiguous audio samples reject offsets/gaps/overlaps and excess durations", () => {
  assert.equal(
    nativeAudioClock(
      [
        { pts: 0, nbSamples: 1024 },
        { pts: 1024, nbSamples: 1024 },
      ],
      { num: 1, den: 48000 },
      48000,
    ).decodedSamples,
    2048,
  );
  for (const pts of [100, 1100, 900])
    assert.throws(() =>
      nativeAudioClock(
        [
          { pts: 0, nbSamples: 1024 },
          { pts, nbSamples: 1024 },
        ],
        { num: 1, den: 48000 },
        48000,
      ),
    );
});
test("strict audio rational clock refuses one-sample offset/gap/overlap, negative origins and fractional physical ends", () => {
  for (const pts of [-1, 1])
    assert.throws(() => nativeAudioClock([{ pts, nbSamples: 1024 }], { num: 1, den: 48000 }, 48000));
  for (const pts of [1023, 1025])
    assert.throws(() =>
      nativeAudioClock(
        [
          { pts: 0, nbSamples: 1024 },
          { pts, nbSamples: 1024 },
        ],
        { num: 1, den: 48000 },
        48000,
      ),
    );
  assert.equal(
    nativeAudioClock(
      [
        { pts: 0, nbSamples: 1024 },
        { pts: 2048, nbSamples: 1024 },
      ],
      { num: 1, den: 96000 },
      48000,
    ).decodedSamples,
    2048,
  );
  assert.throws(() => nativePlayableSamples(48000, 48000, 1, { num: 1, den: 96000 }), /fractional/);
});
test("native video refuses collapsed near-safe rational boundaries before lookup including terminal collapse", () => {
  const max = Number.MAX_SAFE_INTEGER;
  for (const num of [3, 5]) {
    const input = { timebase: { num, den: max }, pts: [0, max - 2, max - 1], terminalTick: max };
    assert.throws(() => validateNativeDecodedClock(input));
    assert.throws(() => nativeDecodedFrameAt(input, 2.9999999999999996));
  }
  const nanos = { timebase: { num: 1, den: 1e9 }, pts: [0, 1, 2], terminalTick: 3 };
  assert.equal(nativeDecodedFrameAt(nanos, 1 / 1e9), 1);
  assert.throws(() => validateNativeDecodedClock({ timebase: { num: 1, den: 1e9 + 1 }, pts: [0, 1], terminalTick: 2 }));
});
test("codec padding is explicit, never missing-speech fill or container-tail invention", () => {
  assert.deepEqual(nativePlayableSamples(48128, 48000, 48000, { num: 1, den: 48000 }), {
    playableSamples: 48000,
    discardedCodecPaddingSamples: 128,
  });
  for (const duration of [49000, 44000, 48000.5])
    assert.throws(() => nativePlayableSamples(48128, 48000, duration, { num: 1, den: 48000 }));
});
test("strict normalization receipts cannot claim dropped source frames or invented audio extent", () => {
  const receipt = {
    version: 1,
    contract: "decoded-source-proxy-v1",
    originalHash: "a".repeat(64),
    ffmpegVersion: "fixture only",
    ffprobeVersion: "fixture only",
    video: {
      clock,
      clockHash: "b".repeat(64),
      ordinalRate: 30,
      proxyHash: "c".repeat(64),
      proxyBytes: 500,
      decodedFrames: 5,
    },
  };
  assert.equal(NativeNormalizationReceiptSchema.safeParse(receipt).success, true);
  assert.equal(
    NativeNormalizationReceiptSchema.safeParse({ ...receipt, video: { ...receipt.video, decodedFrames: 4 } }).success,
    false,
  );
  assert.equal(NativeNormalizationReceiptSchema.safeParse({ ...receipt, command: "injected" }).success, false);
});
const actual = process.env.RUN_NATIVE_NORMALIZATION_TESTS === "1";
test(
  "actual deny-network AAC sample clock and VFR ordinal proxy preserve source pictures",
  { skip: !actual },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "native-normalization-"));
    try {
      const ff = (args: string[], file?: string) =>
        runNativeNormalizationTool("ffmpeg", ["-v", "error", "-threads", "1", ...args], {
          outputFile: file,
          timeoutMs: 10000,
        });
      const probe = async (file: string, selection: string) =>
        JSON.parse(
          (
            await runNativeNormalizationTool("ffprobe", [
              "-v",
              "error",
              "-protocol_whitelist",
              "file,pipe",
              "-select_streams",
              selection,
              "-show_streams",
              "-show_frames",
              "-of",
              "json",
              file,
            ])
          ).toString(),
        );
      const wav = path.join(root, "tone.wav"),
        aac = path.join(root, "tone.m4a");
      await ff(
        ["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=1", "-c:a", "pcm_s16le", wav],
        wav,
      );
      await ff(["-protocol_whitelist", "file,pipe", "-i", wav, "-c:a", "aac", aac], aac);
      const ap = await probe(aac, "a:0"),
        stream = ap.streams[0],
        ab = stream.time_base.split("/").map(Number),
        ac = nativeAudioClock(
          ap.frames.map((f: any) => ({ pts: Number(f.best_effort_timestamp), nbSamples: Number(f.nb_samples) })),
          { num: ab[0], den: ab[1] },
          Number(stream.sample_rate),
        ),
        playable = nativePlayableSamples(ac.decodedSamples, ac.sampleRate, Number(stream.duration_ts), {
          num: ab[0],
          den: ab[1],
        });
      const reference = await ff([
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        wav,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      const pcm = await ff([
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        aac,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      assert.equal(pcm.length / 4, ac.decodedSamples);
      let squareError = 0;
      for (let i = 0; i < playable.playableSamples; i++)
        squareError += (pcm.readFloatLE(i * 4) - reference.readFloatLE(i * 4)) ** 2;
      const aacRmsError = Math.sqrt(squareError / playable.playableSamples);
      assert.ok(aacRmsError < 0.01);
      const endpointErrorSec = playable.playableSamples / ac.sampleRate - (Number(stream.duration_ts) * ab[0]) / ab[1];
      const source = path.join(root, "vfr.mp4"),
        proxy = path.join(root, "ordinal.mkv");
      await ff(
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=64x64:rate=30:duration=1",
          "-vf",
          "select=eq(n\\,0)+eq(n\\,1)+eq(n\\,4)+eq(n\\,9)+eq(n\\,19)+eq(n\\,29)",
          "-fps_mode",
          "vfr",
          "-an",
          "-c:v",
          "libx264",
          "-bf",
          "0",
          "-pix_fmt",
          "yuv420p",
          source,
        ],
        source,
      );
      const vp = await probe(source, "v:0");
      const vs = vp.streams[0],
        vb = vs.time_base.split("/").map(Number),
        vc = nativeDecodedClockFromFrames(
          vp.frames
            .filter((f: any) => f.media_type === "video")
            .map((f: any) => ({
              pts: Number(f.best_effort_timestamp),
              duration: Number(f.duration ?? f.pkt_duration),
            })),
          { num: vb[0], den: vb[1] },
          Number(vs.duration_ts),
        );
      assert.equal(vc.pts.length, 6);
      assert.equal(
        vc.pts.at(-1)! + Number(vp.frames.at(-1).duration ?? vp.frames.at(-1).pkt_duration),
        vc.terminalTick,
      );
      const embedded = path.join(root, "embedded.mp4");
      await ff(
        [
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          source,
          "-i",
          aac,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c",
          "copy",
          embedded,
        ],
        embedded,
      );
      const ep = await probe(embedded, "a:0");
      const ec = nativeAudioClock(
        ep.frames.map((f: any) => ({ pts: Number(f.best_effort_timestamp), nbSamples: Number(f.nb_samples) })),
        { num: ab[0], den: ab[1] },
        ac.sampleRate,
      );
      assert.deepEqual(ec, ac);
      const embeddedPcm = await ff([
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        embedded,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      assert.deepEqual(embeddedPcm, pcm);
      await ff(
        [
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          source,
          "-vf",
          "setpts=N/(30*TB)",
          "-fps_mode",
          "passthrough",
          "-an",
          "-c:v",
          "ffv1",
          "-fflags",
          "+bitexact",
          "-flags:v",
          "+bitexact",
          proxy,
        ],
        proxy,
      );
      const raw = async (file: string) =>
        ff([
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          file,
          "-fps_mode",
          "passthrough",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "yuv420p",
          "pipe:1",
        ]);
      const original = await raw(source),
        derived = await raw(proxy);
      assert.equal(original.length, 64 * 64 * 1.5 * 6);
      assert.deepEqual(derived, original);
      assert.ok(statSync(proxy).size < 64 * 1024 * 1024);
      for (let i = 0; i < vc.pts.length; i++)
        assert.equal(nativeDecodedFrameAt(vc, (vc.pts[i]! * vc.timebase.num) / vc.timebase.den), i);
      const report = {
        phase: "CPU feasibility only",
        videoClock: vc,
        ordinalRate: 30,
        originalFrameCount: 6,
        allDecodedPicturesEqual: true,
        proxyDurationIsNotOriginalDuration: true,
        embeddedDecodedPcmEqualsIsolatedAac: true,
        audioClock: ac,
        playable,
        aacRmsError,
        endpointErrorSec,
        decodedPcmSamples: pcm.length / 4,
        originalHash: createHash("sha256").update(readFileSync(source)).digest("hex"),
        proxyHash: createHash("sha256").update(readFileSync(proxy)).digest("hex"),
        limits:
          "Synthetic1s64px; embedded demux feasibility only, no native capture acceptance; AAC compared to decoded AAC, not bit-identical pre-encoding PCM",
      };
      if (process.env.NATIVE_NORMALIZATION_EVIDENCE)
        writeFileSync(process.env.NATIVE_NORMALIZATION_EVIDENCE, JSON.stringify(report, null, 2) + "\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  "actual tool deadline and disk/output bounds reject without waiting for remote work",
  { skip: !actual },
  async () => {
    await assert.rejects(
      runNativeNormalizationTool(
        "ffmpeg",
        ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=30", "-f", "rawvideo", "pipe:1"],
        { timeoutMs: 100, maxOutputBytes: 1024 },
      ),
      /bound|deadline/,
    );
    await assert.rejects(runNativeNormalizationTool("ffprobe", ["-version"], { timeoutMs: 1 }), /deadline/);
  },
);
