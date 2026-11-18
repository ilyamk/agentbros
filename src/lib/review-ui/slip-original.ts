import { lstatSync, openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fraction, mul, div, compare } from "../timeline-ir/rational";
import { assertSplitOriginal } from "./split-original";
const integer = (value: unknown) => {
  if (typeof value !== "number" && typeof value !== "string") throw Error("Physical video clock unavailable");
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw Error("Physical video clock unavailable");
  return n;
};
const rate = (value: unknown) => {
  const m = /^(\d+)\/(\d+)$/.exec(String(value));
  if (!m) throw Error("Physical video rate unavailable");
  const r = fraction(integer(m[1]), integer(m[2]));
  if (r.num <= 0) throw Error("Physical video rate unavailable");
  return r;
};
/** Finite preparation-only decoded clock proof. Does not certify generic Apply against filesystem races. */
export function inspectSlipOriginal(file: string, sha: string) {
  const noAliases = () => {
    let current = path.resolve(file);
    while (true) {
      if (lstatSync(current).isSymbolicLink())
        throw Error("Source slip original ancestors must not be symlink aliases");
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  noAliases();
  assertSplitOriginal(file, sha, "video");
  if (path.extname(file).toLowerCase() !== ".mp4") throw Error("Source slip currently supports MP4 originals only");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw Error("Source slip requires a regular MP4");
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, 12, 0) !== 12 || header.toString("ascii", 4, 8) !== "ftyp")
      throw Error("Source slip requires an MP4 container signature; playlists are unsupported");
  } finally {
    closeSync(fd);
  }
  const probe = (args: string[]) =>
    JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", ...args, "-of", "json", file], {
        encoding: "utf8",
        timeout: 10000,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }),
    );
  const streams = probe([
    "-show_entries",
    "stream=codec_type,codec_name,r_frame_rate,avg_frame_rate,time_base,width,height:stream_tags=rotate:stream_side_data=rotation",
  ]).streams;
  if (!Array.isArray(streams)) throw Error("Physical video streams unavailable");
  const videos = streams.filter((s) => s.codec_type === "video");
  if (videos.length !== 1 || videos[0].codec_name !== "h264")
    throw Error("Source slip requires exactly one physical H264 video stream");
  const video = videos[0],
    physicalRate = rate(video.r_frame_rate),
    tick = rate(video.time_base);
  if (compare(physicalRate, rate(video.avg_frame_rate)) !== 0 || compare(physicalRate, fraction(120)) > 0)
    throw Error("Source slip requires bounded CFR video");
  if (
    !Number.isSafeInteger(video.width) ||
    !Number.isSafeInteger(video.height) ||
    video.width <= 0 ||
    video.height <= 0 ||
    video.width * video.height > 3840 * 2160 ||
    video.tags?.rotate ||
    video.side_data_list?.some((s: { rotation?: number }) => s.rotation !== undefined && s.rotation !== 0)
  )
    throw Error("Source slip requires bounded unrotated video");
  const frames = probe([
    "-select_streams",
    "v:0",
    "-show_frames",
    "-show_entries",
    "frame=best_effort_timestamp,duration,pkt_duration",
  ]).frames;
  if (!Array.isArray(frames) || !frames.length || frames.length > 18000)
    throw Error("Source slip decoded frame count exceeds bounded inspection");
  const period = div(fraction(1), physicalRate);
  frames.forEach((frame, i) => {
    const start = mul(fraction(integer(frame.best_effort_timestamp)), tick),
      duration = mul(fraction(integer(frame.duration ?? frame.pkt_duration)), tick);
    if (compare(start, mul(fraction(i), period)) !== 0 || compare(duration, period) !== 0)
      throw Error("Source slip requires contiguous zero-origin decoded CFR video; normalize VFR explicitly");
  });
  const physicalDuration = mul(fraction(frames.length), period);
  if (compare(physicalDuration, fraction(600)) > 0) throw Error("Source slip physical duration exceeds600seconds");
  noAliases();
  assertSplitOriginal(file, sha, "video");
  return { physicalRate, physicalDuration, decodedFrames: frames.length };
}
