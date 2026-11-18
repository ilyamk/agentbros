import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  linkSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { projectChapterPlan } from "./runner";
import { hashFile } from "../assets/registry";
import { stableHash } from "./plans";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe } from "../cli";
type Plan = ReturnType<typeof projectChapterPlan>;
function reject(message: string): never {
  throw new CliErrorObject({ code: "VALIDATION", message });
}
function safe(root: string, file: string) {
  file = path.resolve(file);
  const rel = path.relative(root, file);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) reject("Assembly path escapes root");
  let at = file;
  while (at !== root) {
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) reject("Assembly paths cannot be symlinks");
    at = path.dirname(at);
  }
  return file;
}
function ff(args: string[], timeout: number) {
  const p = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (p.error || p.status !== 0) reject(`Chapter assembly FFmpeg failed: ${p.error?.message ?? p.stderr.slice(-2000)}`);
  return p;
}
function probe(file: string) {
  const p = spawnSync(
    "ffprobe",
    ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file],
    { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (p.error || p.status !== 0) reject("Assembly input cannot be fully probed");
  return JSON.parse(p.stdout) as {
    streams: Array<{
      codec_type: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      nb_read_frames?: string;
      sample_rate?: string;
      channels?: number;
    }>;
    format: { duration: string };
  };
}
export function assembleChapters(
  plan: Plan,
  result?: { outputs: string[] },
  options: { rootDir?: string; outputFile?: string; timeoutMs?: number } = {},
) {
  ensureFfmpeg();
  ensureFfprobe();
  const captions =
    (plan as Plan & { captions?: "on" | "off" }).captions ??
    (plan.jobs[0]?.props.captionsEnabled === false ? "off" : "on");
  if (captions !== "on" && captions !== "off") reject("Invalid assembly caption variant");
  if (plan.jobs.some((job) => (job.props.captionsEnabled !== false) !== (captions === "on")))
    reject("Assembly cannot mix clean and captioned chapter jobs");
  const root = realpathSync(
    options.rootDir ??
      path.resolve(path.dirname(plan.cacheFile), captions === "off" ? "../../../../.." : "../../../.."),
  );
  const timeout = options.timeoutMs ?? 600000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 1800000) reject("Invalid assembly timeout");
  const projectId = plan.jobs[0]?.props.projectId,
    format = plan.jobs[0]?.format;
  if (
    !projectId ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId) ||
    !["vertical", "square", "landscape"].includes(format)
  )
    reject("Invalid assembly project/format");
  if (plan.jobs.some((job) => job.props.projectId !== projectId || job.format !== format))
    reject("Assembly cannot mix projects or formats");
  const expectedCache = path.join(
    root,
    "out",
    projectId,
    "chapters",
    format,
    ...(captions === "off" ? ["clean"] : []),
    "cache.json",
  );
  if (path.resolve(plan.cacheFile) !== expectedCache) reject("Assembly cache must belong to selected project/format");
  const directory = path.dirname(safe(root, plan.cacheFile));
  if (plan.jobs.length < 1 || plan.jobs.length > 64) reject("Invalid assembly chapter count");
  if (!existsSync(plan.cacheFile) || statSync(plan.cacheFile).size > 4 * 1024 * 1024)
    reject("Assembly requires bounded verified chapter cache");
  const cache = JSON.parse(readFileSync(plan.cacheFile, "utf8")) as Record<
    string,
    { fingerprint: string; output: string; outputHash: string }
  >;
  if (result && result.outputs.length !== plan.jobs.length)
    reject("Assembly result must contain every chapter in order");
  let width = 0,
    height = 0,
    totalFrames = 0,
    totalBytes = 0;
  const children = plan.jobs.map((job, i) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(job.chapterId) ||
      !/^[a-f0-9]{64}$/.test(job.fingerprint) ||
      !Number.isSafeInteger(job.durationInFrames) ||
      job.durationInFrames <= 0
    )
      reject("Invalid chapter identity/frame count");
    const entry = cache[job.chapterId],
      file = safe(root, path.join(directory, `${job.chapterId}-${job.fingerprint}.mp4`));
    if (
      !entry ||
      entry.fingerprint !== job.fingerprint ||
      path.resolve(entry.output) !== file ||
      !/^[a-f0-9]{64}$/.test(entry.outputHash) ||
      (result && path.resolve(result.outputs[i]) !== file)
    )
      reject("Chapter input differs from verified cache identity");
    if (!existsSync(file) || !statSync(file).isFile()) reject("Missing chapter output");
    totalBytes += statSync(file).size;
    if (totalBytes > 4 * 1024 * 1024 * 1024) reject("Assembly inputs exceed 4GiB");
    if (hashFile(file) !== entry.outputHash) reject("Chapter checksum mismatch");
    const data = probe(file),
      video = data.streams.find((s) => s.codec_type === "video"),
      audio = data.streams.find((s) => s.codec_type === "audio");
    if (Math.abs(Number(data.format.duration) - job.durationInFrames / 30) > 0.08) reject("Chapter duration mismatch");
    if (
      !video ||
      video.avg_frame_rate !== "30/1" ||
      Number(video.nb_read_frames) !== job.durationInFrames ||
      !video.width ||
      !video.height ||
      video.width > 3840 ||
      video.height > 3840 ||
      video.width % 2 ||
      video.height % 2
    )
      reject("Chapter dimensions/FPS/frame count mismatch");
    if (
      !audio ||
      !Number.isInteger(Number(audio.sample_rate)) ||
      Number(audio.sample_rate) < 8000 ||
      Number(audio.sample_rate) > 192000 ||
      !audio.channels ||
      audio.channels > 2
    )
      reject("Assembly requires compatible chapter audio; silent chapters need an explicit authored silent track");
    const count = ff(
      [
        "-v",
        "info",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-af",
        "astats=metadata=0:reset=0",
        "-f",
        "null",
        "-",
      ],
      timeout,
    );
    const counts = [...count.stderr.matchAll(/Number of samples:\s*(\d+)/g)].map((m) => Number(m[1]));
    if (!counts.length || Math.min(...counts) < Math.round((job.durationInFrames * Number(audio.sample_rate)) / 30))
      reject("Chapter audio is shorter than authored frame span");
    if (!width) {
      width = video.width;
      height = video.height;
    }
    if (width !== video.width || height !== video.height) reject("Chapter dimensions differ");
    totalFrames += job.durationInFrames;
    if (totalFrames > 30 * 3600) reject("Assembly duration exceeds one hour");
    return {
      chapterId: job.chapterId,
      fingerprint: job.fingerprint,
      sha256: entry.outputHash,
      frames: job.durationInFrames,
      file: path.relative(root, file),
      width: video.width,
      height: video.height,
      fps: 30,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
      fontCapture: (
        job as typeof job & {
          fontCapture?: { contextFile: string; hashes: Record<string, string> };
        }
      ).fontCapture,
    };
  });
  const identity = stableHash({
      version: 1,
      captions,
      children,
      encoding: {
        video: "h264",
        audio: "aac",
        sampleRate: 48000,
        channels: 2,
        frameTrim: true,
      },
    }),
    output = safe(root, options.outputFile ?? path.join(directory, `assembled-${identity}.mp4`)),
    receipt = safe(root, `${output}.assembly.json`);
  const relOutput = path.relative(path.join(root, "out", projectId), output);
  if (relOutput === ".." || relOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relOutput))
    reject("Assembly output must stay in selected project output directory");
  const verify = (file: string) => {
    const p = probe(file),
      v = p.streams.find((s) => s.codec_type === "video"),
      a = p.streams.find((s) => s.codec_type === "audio");
    if (
      !v ||
      Number(v.nb_read_frames) !== totalFrames ||
      v.avg_frame_rate !== "30/1" ||
      v.width !== width ||
      v.height !== height ||
      !a ||
      Number(a.sample_rate) !== 48000 ||
      Math.abs(Number(p.format.duration) - totalFrames / 30) > 1 / 30 + 0.001
    )
      reject("Assembled media timing/streams mismatch");
    ff(["-v", "error", "-i", file, "-f", "null", "-"], timeout);
    return p;
  };
  if (existsSync(output) || existsSync(receipt)) {
    if (!existsSync(output) || !existsSync(receipt) || statSync(receipt).size > 4 * 1024 * 1024)
      reject("Assembly destination is incomplete or already occupied");
    const report = JSON.parse(readFileSync(receipt, "utf8"));
    if (report.identity !== identity || report.outputSha256 !== hashFile(output))
      reject("Assembly destination contains different immutable bytes");
    verify(output);
    return {
      outputs: [output, receipt],
      metadata: {
        identity,
        reused: true,
        totalFrames,
        durationSec: totalFrames / 30,
      },
      report,
    };
  }
  // No directory is created until all existing ancestors have been checked.
  mkdirSync(path.dirname(output), { recursive: true });
  const lock = safe(root, `${output}.lock`),
    fd = openSync(lock, "wx", 0o600),
    temporary = safe(root, `${output}.${randomUUID()}.mp4`),
    temporaryReceipt = safe(root, `${receipt}.${randomUUID()}.tmp`);
  let receiptPublished = false;
  try {
    const graph =
      children
        .map(
          (c, i) =>
            `[${i}:v]trim=end_frame=${c.frames},setpts=PTS-STARTPTS[v${i}];[${i}:a]atrim=end_sample=${Math.round((c.frames * c.sampleRate) / 30)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`,
        )
        .join(";") +
      ";" +
      children.map((_, i) => `[v${i}][a${i}]`).join("") +
      `concat=n=${children.length}:v=1:a=1[v][a]`;
    ff(
      [
        "-v",
        "error",
        ...children.flatMap((c) => ["-protocol_whitelist", "file,pipe", "-i", path.join(root, c.file)]),
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        temporary,
      ],
      timeout,
    );
    const verified = verify(temporary);
    for (const c of children)
      if (hashFile(path.join(root, c.file)) !== c.sha256) reject("Chapter changed while assembly was running");
    const report = {
      version: 1,
      identity,
      captions,
      children,
      totalFrames,
      fps: 30,
      width,
      height,
      durationSec: totalFrames / 30,
      outputSha256: hashFile(temporary),
      outputFile: path.relative(root, output),
      audio: {
        sampleRate: 48000,
        channels: 2,
        trim: "per-chapter source sample count",
      },
      fullDecodeVerified: true,
      canonicalPixelIdentity: false,
      encoding: "Full assembly is locally re-encoded; unchanged chapter renders are reused",
      probe: verified,
    };
    writeFileSync(temporaryReceipt, JSON.stringify(report, null, 2), {
      flag: "wx",
    });
    linkSync(temporaryReceipt, receipt);
    receiptPublished = true;
    linkSync(temporary, output);
    return {
      outputs: [output, receipt],
      metadata: {
        identity,
        reused: false,
        totalFrames,
        durationSec: totalFrames / 30,
      },
      report,
    };
  } catch (error) {
    if (receiptPublished && !existsSync(output)) rmSync(receipt, { force: true });
    throw error;
  } finally {
    rmSync(temporary, { force: true });
    rmSync(temporaryReceipt, { force: true });
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
