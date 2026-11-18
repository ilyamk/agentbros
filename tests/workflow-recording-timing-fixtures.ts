import path from "node:path";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";

/** Plan: genuine FFmpeg clocks, source-index decisions, independent measured PTS oracle;
 * success means conserved wall-clock/audio, reviewed rational mapping and immutable originals. */
export function timingFixture(
  root: string,
  mode: "ntsc" | "vfr" | "high-fps" | "vfr-boundary",
  durationSec = 6,
  shortestAudio = false,
) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, `${mode}-original.mp4`);
  const rate = mode === "ntsc" ? "30000/1001" : mode === "high-fps" ? "120" : mode === "vfr-boundary" ? "60" : "30";
  const filter = [
    "drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(t,2)*lt(t,4)'",
    "drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,4)'",
    ...(mode === "vfr"
      ? ["select='not(eq(mod(n,30),8)+eq(mod(n,30),9))'"]
      : mode === "vfr-boundary"
        ? ["select='not(eq(mod(n,4),1)+eq(mod(n,4),2))'"]
        : []),
  ].join(",");
  const audioDuration = shortestAudio
    ? durationSec + 0.04
    : mode === "ntsc"
      ? (Math.ceil((durationSec * 30000) / 1001) * 1001) / 30000
      : durationSec;
  const baseAudio = "if(lt(t\\,2)\\,0.2*sin(2*PI*440*t)\\,if(lt(t\\,4)\\,0.2*sin(2*PI*660*t)\\,0.2*sin(2*PI*880*t)))";
  const audio =
    mode === "vfr-boundary" ? `if(between(t\\,4.051\\,4.06)\\,0.7*sin(2*PI*2200*t)\\,${baseAudio})` : baseAudio;
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=red:s=320x180:r=${rate}:d=${durationSec}`,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${audio}:s=48000:d=${audioDuration}`,
    "-vf",
    filter,
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    ...(shortestAudio ? ["-shortest"] : []),
    file,
  ]);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_streams",
        "-show_entries",
        "frame=best_effort_timestamp_time:stream=duration,r_frame_rate,avg_frame_rate",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    ),
  );
  const pts = probe.frames.map((frame: { best_effort_timestamp_time: string }) =>
    Number(frame.best_effort_timestamp_time),
  ) as number[];
  const duration = Number(probe.streams[0].duration);
  const two = pts.findIndex((time) => time >= 2),
    four = pts.findIndex((time) => time >= 4);
  if (two < 0 || four < 0) throw new Error("Fixture lacks independent measured cut boundaries");
  const request = {
    version: 2,
    workflow: "recording-edit",
    projectId: `recut-${mode}`,
    name: `Synthetic timing acceptance ${mode}`,
    profile: "recording-only",
    formats: ["landscape"],
    source: {
      file,
      sha256: hashFile(file),
      version: "technical-take-1",
      fps:
        mode === "ntsc"
          ? { num: 30000, den: 1001 }
          : { num: mode === "high-fps" ? 120 : mode === "vfr-boundary" ? 60 : 30, den: 1 },
      normalization: {
        targetFps: { num: 30, den: 1 },
        video: "timestamp-near",
        boundaryRounding: "nearest",
        keepRounding: "outward",
        audio: "preserve-clock",
      },
    },
    transcript: {
      version: "technical-transcript-v1",
      language: "ru",
      words: [
        { id: "first", text: "Это", startFrame: 0, endFrame: 4 },
        { id: "negation", text: "не", startFrame: 4, endFrame: 7 },
        { id: "claim", text: "гарантия.", startFrame: 7, endFrame: Math.min(two, 22) },
        { id: "removed", text: "Повтор.", startFrame: two + 2, endFrame: two + 12 },
        { id: "condition", text: "Если", startFrame: four, endFrame: four + 7 },
        { id: "tail", text: "проверено.", startFrame: four + 7, endFrame: pts.length },
      ],
    },
    keepSpans: [
      { id: "first", startFrame: 0, endFrame: two, reason: "Preserve complete technical negation" },
      { id: "last", startFrame: four, endFrame: pts.length, reason: "Preserve technical condition and final word" },
    ],
    cuts: [{ startFrame: two, endFrame: four, reason: "Synthetic reviewed repeated interval" }],
    protectedSpans: [
      { startFrame: 0, endFrame: Math.min(two, 22), kind: "negation", reason: "Whole negative statement" },
      { startFrame: four, endFrame: pts.length, kind: "caveat", reason: "Whole conditional statement" },
    ],
    revision: 1,
  };
  return { request, pts, duration, two, four, probe };
}
export function masterBoundary(fixture: ReturnType<typeof timingFixture>, frame: number) {
  return Math.round((frame === fixture.pts.length ? fixture.duration : fixture.pts[frame]) * 30);
}
export function tone(file: string, start: number) {
  const duration = 0.25;
  const bytes = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "-",
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  let square = 0,
    crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    square += samples[i] ** 2;
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  }
  return { hz: crossings / duration, rms: Math.sqrt(square / samples.length), samples: samples.length };
}
export function colorAt(file: string, time: number) {
  const bytes = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(time),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "crop=40:40:140:40,scale=1:1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 1024 },
  );
  return [...bytes];
}

export function keepMasterBoundary(fixture: ReturnType<typeof timingFixture>, frame: number, edge: "start" | "end") {
  const ticks = (frame === fixture.pts.length ? fixture.duration : fixture.pts[frame]) * 30;
  return edge === "start" ? Math.floor(ticks + 1e-9) : Math.ceil(ticks - 1e-9);
}
