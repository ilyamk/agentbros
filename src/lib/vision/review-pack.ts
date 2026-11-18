import { localInputHash, readLocalJson } from "../audio/local-input";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPathWithin, CliErrorObject } from "../cli";
import { probeVideo, writeImage, type VideoInfo } from "./media";
import { differenceMap, RgbImage } from "./image";
import {
  VisionManifestSchema,
  VisionRequestSchema,
  type VisionEvent,
  type VisionManifest,
  type VisionRequest,
} from "../../types/vision-review";
import { renderReviewHtml, reviewLayout } from "./review-view";

export const reviewHash = localInputHash;
export const REVIEW_INPUT_OPTIONS = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,avi,mpegts,png_pipe,jpeg_pipe",
];
export function confineReviewPath(root: string, file: string): void {
  const absolute = path.resolve(file);
  let ancestor = absolute;
  while (!existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  assertPathWithin(realpathSync(root), path.resolve(realpathSync(ancestor), path.relative(ancestor, absolute)));
}
const invalid = (message: string): never => {
  throw new CliErrorObject({ code: "VALIDATION", message });
};
export function visionCommand(binary: string, args: string[]): Buffer {
  const inputAt = args.indexOf("-i");
  const confined =
    binary === "ffprobe"
      ? [...REVIEW_INPUT_OPTIONS, ...args]
      : binary === "ffmpeg" && inputAt >= 0
        ? [...args.slice(0, inputAt), ...REVIEW_INPUT_OPTIONS, ...args.slice(inputAt)]
        : args;
  const result = spawnSync(binary, confined, { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  if (result.status !== 0 || result.error)
    invalid(`${binary}: ${result.error?.message ?? result.stderr?.toString().slice(-600)}`);
  return result.stdout;
}

export function selectReviewFrames(
  info: VideoInfo,
  request: VisionRequest,
): { selected: VisionEvent[]; omitted: VisionEvent[] } {
  const first = request.startFrame ?? 0,
    last = request.endFrame ?? info.frameCount - 1;
  if (last >= info.frameCount || first > last) invalid("Review window is outside the decoded video.");
  const candidates = new Map<number, VisionEvent>();
  const add = (event: VisionEvent) => {
    if (event.frame < first || event.frame > last) return;
    const previous = candidates.get(event.frame);
    candidates.set(event.frame, {
      ...event,
      ...previous,
      reasons: [...new Set([...(previous?.reasons ?? []), ...event.reasons])],
      reasonEvidence: [
        ...(previous?.reasonEvidence ?? []),
        ...event.reasons.map((reason) => ({ reason, basis: event.basis })),
      ],
    });
  };
  for (const event of request.events) {
    if (event.frame >= info.frameCount) invalid(`Event frame ${event.frame} is outside the source.`);
    add(event);
    if (request.profile === "motion")
      for (const offset of [-2, -1, 1, 2])
        add({ frame: event.frame + offset, reasons: [`neighbour of F${event.frame}`], basis: event.basis });
  }
  for (const crop of request.crops) add({ frame: crop.frame, reasons: ["requested crop"], basis: "declared" });
  if (request.profile === "motion" && (request.startFrame !== undefined || request.endFrame !== undefined)) {
    for (let frame = first; frame <= last; frame += request.step)
      add({ frame, reasons: [`motion window step ${request.step}`], basis: "declared" });
  } else
    for (let index = 0; index < request.count; index++)
      add({
        frame: Math.round(first + (index * (last - first)) / (request.count - 1)),
        reasons: ["whole-window overview"],
        basis: "declared",
      });
  add({ frame: first, reasons: ["window first"], basis: "declared" });
  add({ frame: last, reasons: ["window last"], basis: "declared" });
  const all = [...candidates.values()].sort((a, b) => a.frame - b.frame);
  if (all.length === 1) return { selected: all, omitted: [] };
  // Keep endpoints and distribute the remaining budget across the complete window.
  const indices = new Set(
    Array.from({ length: Math.min(request.maxFrames, all.length) }, (_, i) =>
      Math.round((i * (all.length - 1)) / (Math.min(request.maxFrames, all.length) - 1)),
    ),
  );
  return { selected: all.filter((_, i) => indices.has(i)), omitted: all.filter((_, i) => !indices.has(i)) };
}

export function verifyReviewClock(input: string, info: VideoInfo): void {
  const values = visionCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    input,
  ])
    .toString()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => Number(line.split(",")[0]));
  if (!values.length || values.some((t) => !Number.isFinite(t)))
    invalid("Missing frame timestamps; exact review clock unavailable.");
  if (
    Math.abs(values[0]!) > 0.001 ||
    values.some((t, i) => i > 0 && Math.abs(t - values[i - 1]! - 1 / info.fps) > 0.0001)
  )
    invalid(
      "Exact review requires zero-origin CFR media. Conform VFR/nonzero-origin footage first; no frame times were guessed.",
    );
  if (values.length !== info.frameCount) invalid("Decoded frame count differs from the source metadata.");
}

export type ReviewStills = { info: VideoInfo; identityFile: string; frames: Array<{ frame: number; path: string }> };
export function writeReviewPack(
  raw: unknown,
  directory: string,
  options: { scopeRoot?: string; stills?: ReviewStills; measurementOrigin?: "qa-evidence" } = {},
) {
  const request = VisionRequestSchema.parse(raw);
  const input = path.resolve(request.input),
    root = options.scopeRoot;
  if (root) {
    confineReviewPath(root, input);
    confineReviewPath(root, directory);
  }
  if (!statSync(input).isFile()) invalid("Review source must be a local file.");
  if (root && options.stills) confineReviewPath(root, options.stills.identityFile);
  const initialHash = reviewHash(options.stills?.identityFile ?? input);
  const info = options.stills?.info ?? probeVideo(input, REVIEW_INPUT_OPTIONS);
  if (info.width * info.height > 3840 * 2160 || info.frameCount > 1_000_000)
    invalid("Review source exceeds the bounded 4K/frame budget.");
  if (root && options.stills) for (const frame of options.stills.frames) confineReviewPath(root, frame.path);
  if (!options.stills) verifyReviewClock(input, info);
  const selection = selectReviewFrames(info, request);
  if (
    options.stills &&
    selection.selected.some((event) => !options.stills!.frames.some((frame) => frame.frame === event.frame))
  )
    invalid("Composition review is missing a selected full-resolution still.");
  for (const crop of request.crops)
    if (crop.frame >= info.frameCount || crop.x + crop.width > info.width || crop.y + crop.height > info.height)
      invalid("Requested crop is outside the source frame.");
  if (request.measurements.some((m) => m.sourceSha256 !== initialHash || m.frame >= info.frameCount))
    invalid("Measurement source hash or frame does not match this review.");
  if (!options.measurementOrigin)
    request.measurements = request.measurements.map((m) => ({
      ...m,
      basis: "declared",
      evidence: `Caller supplied, unverified: ${m.evidence}`,
    }));
  if (existsSync(directory)) invalid("Review output already exists; choose a new directory.");
  mkdirSync(path.join(directory, "frames"), { recursive: true });
  const target = path.resolve(directory);
  if (!options.stills) {
    const expression = selection.selected.map((event) => `eq(n\\,${event.frame})`).join("+");
    visionCommand("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-i",
      input,
      "-an",
      "-sn",
      "-map",
      "0:v:0",
      "-vf",
      `select=${expression}`,
      "-fps_mode",
      "passthrough",
      "-threads",
      "2",
      "-start_number",
      "0",
      path.join(target, "frames", "%06d.png"),
    ]);
    if (readdirSync(path.join(target, "frames")).length !== selection.selected.length)
      invalid("Selected frames were not all decoded.");
  }
  const frames: VisionManifest["frames"] = selection.selected.map((event, index) => {
    const file =
      options.stills?.frames.find((f) => f.frame === event.frame)?.path ??
      path.join(target, "frames", `${String(index).padStart(6, "0")}.png`);
    const output = path.join(target, "frames", `${String(index).padStart(6, "0")}.png`);
    if (file !== output) writeFileSync(output, readFileSync(file), { flag: "wx" });
    return {
      ...event,
      id: `F${String(event.frame).padStart(6, "0")}`,
      timeSec: event.frame / info.fps,
      path: path.relative(target, output),
      sha256: reviewHash(output),
      measurements: request.measurements.filter((m) => m.frame === event.frame),
      crops: request.crops
        .filter((c) => c.frame === event.frame)
        .map((crop, n) => {
          const cropFile = path.join(target, "frames", `crop-${event.frame}-${n}.png`);
          visionCommand("ffmpeg", [
            "-v",
            "error",
            "-nostdin",
            "-i",
            output,
            "-vf",
            `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
            "-frames:v",
            "1",
            "-threads",
            "1",
            cropFile,
          ]);
          return { ...crop, path: path.relative(target, cropFile), sha256: reviewHash(cropFile) };
        }),
    };
  });
  const warnings = [
    "Missing measurements are unverified; declared text is not proof of visible pixels.",
    ...(selection.omitted.length
      ? [`${selection.omitted.length} candidate frames omitted by maxFrames; motion coverage is incomplete.`]
      : []),
    ...(request.profile === "motion" && request.step > 1
      ? ["Motion sampling skips source frames; brief defects may be missed."]
      : []),
  ];
  if (request.profile === "motion") {
    let previous: RgbImage | undefined;
    const width = 300,
      height = Math.max(2, Math.round((width * info.height) / info.width));
    for (const [index, frame] of frames.entries()) {
      const pixels = visionCommand("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-i",
        path.join(target, frame.path),
        "-vf",
        `scale=${width}:${height}`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ]);
      const image = new RgbImage(width, height, pixels);
      if (previous) {
        const diff = differenceMap(image, previous),
          file = path.join(target, "frames", `diff-${frame.frame}.png`);
        writeImage(diff.image, file);
        frame.diff = {
          path: path.relative(target, file),
          sha256: reviewHash(file),
          previousFrame: frames[index - 1]!.frame,
          mean: diff.mean,
        };
      }
      previous = image;
    }
  }
  const manifest: VisionManifest = {
    version: 1,
    profile: request.profile,
    source: {
      path: path.resolve(options.stills?.identityFile ?? input),
      sha256: initialHash,
      kind: options.stills ? "composition" : "video",
      width: info.width,
      height: info.height,
      fps: info.fps,
      frameCount: info.frameCount,
      clock: options.stills ? "composition-frames" : "verified-cfr",
    },
    request,
    frames,
    pages: [],
    omitted: selection.omitted,
    warnings,
    readingOrder: [],
    status: "needs-review",
  };
  const layout = reviewLayout(info, request.profile, request.phone);
  const groups = Array.from({ length: Math.ceil(frames.length / layout.perPage) }, (_, index) =>
    frames.slice(index * layout.perPage, (index + 1) * layout.perPage),
  );
  for (const frame of frames)
    visionCommand("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-i",
      path.join(target, frame.path),
      "-vf",
      `scale=${layout.tileWidth}:${layout.tileHeight}`,
      "-frames:v",
      "1",
      "-threads",
      "1",
      path.join(target, "frames", `preview-${frame.frame}.png`),
    ]);
  groups.forEach((group, index) => {
    const name = `page-${String(index + 1).padStart(3, "0")}`;
    const html = `${name}.html`,
      png = `${name}.png`;
    writeFileSync(path.join(target, html), renderReviewHtml(manifest, group, layout, target));
    manifest.pages.push({
      path: png,
      html,
      htmlSha256: reviewHash(path.join(target, html)),
      sha256: "0".repeat(64),
      width: layout.width,
      height: layout.height(group.length),
      frameIds: group.map((f) => f.id),
      kind: "frames",
    });
    if (group.some((f) => f.diff)) {
      const diffFrames = group
        .filter((f) => f.diff)
        .map((f) => ({
          ...f,
          path: f.diff!.path,
          reasons: [`x4 pixel difference from F${f.diff!.previousFrame}; mean ${f.diff!.mean.toFixed(2)} / 255`],
          measurements: [],
          text: undefined,
        }));
      writeFileSync(path.join(target, `${name}-diff.html`), renderReviewHtml(manifest, diffFrames, layout, target));
      manifest.pages.push({
        path: `${name}-diff.png`,
        html: `${name}-diff.html`,
        htmlSha256: reviewHash(path.join(target, `${name}-diff.html`)),
        sha256: "0".repeat(64),
        width: layout.width,
        height: layout.height(diffFrames.length),
        frameIds: diffFrames.map((f) => f.id),
        kind: "diff",
      });
    }
  });
  writeFileSync(
    path.join(target, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Review pages</title>${manifest.pages.map((p, i) => `<p><a href="${p.html}">Page ${i + 1}</a> · <a href="${p.path}">PNG</a></p>`).join("")}`,
  );
  const job = path.join(target, "pages.json");
  writeFileSync(job, JSON.stringify(manifest.pages));
  const worker = fileURLToPath(new URL("./review-render-worker.ts", import.meta.url));
  const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  visionCommand(process.execPath, [tsx, worker, target, job]);
  for (const page of manifest.pages) page.sha256 = reviewHash(path.join(target, page.path));
  if (reviewHash(options.stills?.identityFile ?? input) !== initialHash)
    invalid("Source changed during review capture.");
  manifest.readingOrder = [...manifest.pages.map((p) => p.path), ...frames.flatMap((f) => f.crops.map((c) => c.path))];
  const file = path.join(target, "manifest.json");
  writeFileSync(file, JSON.stringify(VisionManifestSchema.parse(manifest), null, 2));
  return {
    manifest: file,
    html: path.join(target, "index.html"),
    outputs: [file, ...manifest.readingOrder.map((f) => path.join(target, f))],
    data: manifest,
  };
}

export function inspectReviewPack(
  file: string,
  options: { scopeRoot?: string; frame?: number; limit?: number; verifySource?: boolean } = {},
) {
  if (options.scopeRoot) confineReviewPath(options.scopeRoot, file);
  const base = path.dirname(path.resolve(file)),
    manifest = VisionManifestSchema.parse(readLocalJson(file, 32 * 1024 * 1024));
  for (const frame of manifest.frames)
    for (const asset of [frame, ...frame.crops, ...(frame.diff ? [frame.diff] : [])]) {
      const local = path.resolve(base, asset.path);
      assertPathWithin(base, local);
      if (reviewHash(local) !== asset.sha256) invalid("Review frame or crop hash mismatch.");
    }
  for (const page of manifest.pages)
    for (const [file, hash] of [
      [page.path, page.sha256],
      [page.html, page.htmlSha256],
    ]) {
      const local = path.resolve(base, file!);
      assertPathWithin(base, local);
      if (reviewHash(local) !== hash) invalid("Review page hash mismatch.");
    }
  if (options.verifySource !== false) {
    if (options.scopeRoot) confineReviewPath(options.scopeRoot, manifest.source.path);
    if (reviewHash(manifest.source.path) !== manifest.source.sha256) invalid("Review source is stale.");
  }
  const limit = options.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be 1..100.");
  const selected = manifest.frames.filter((f) => options.frame === undefined || f.frame === options.frame);
  return {
    ...manifest,
    frames: selected.slice(0, limit),
    returned: Math.min(limit, selected.length),
    totalFrames: manifest.frames.length,
    truncated: selected.length > limit,
  };
}
