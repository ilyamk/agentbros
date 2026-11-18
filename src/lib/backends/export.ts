import { z } from "zod";
import { RationalSchema, TimebaseSchema } from "../../types/timeline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { Rational, TimelineIR } from "../../types/timeline";
import { compileTimelineIR, validateTimeline, clipDuration } from "../timeline-ir/compiler";
import { fraction, add, sub, div, mul, numeric, compare } from "../timeline-ir/rational";
export type ExportAsset = {
  path: string;
  kind: "video" | "audio" | "image";
  timebase: Rational;
  durationFrames: Rational;
  width?: number;
  height?: number;
  hasAudio?: boolean;
};
export type ExportAssets = Record<string, ExportAsset>;
const ExportAssetSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["video", "audio", "image"]),
    timebase: TimebaseSchema,
    durationFrames: RationalSchema.refine((v) => v.num > 0),
    width: z.number().int().positive().safe().optional(),
    height: z.number().int().positive().safe().optional(),
    hasAudio: z.boolean().optional(),
  })
  .strict();
const seconds = (frame: Rational, fps: Rational) => div(frame, fps);
const time = (frame: Rational, fps: Rational) => {
  const value = seconds(frame, fps);
  return `${value.num}/${value.den}s`;
};
const rt = (value: Rational, rate: Rational) => ({
  OTIO_SCHEMA: "RationalTime.1",
  value: numeric(value),
  rate: numeric(rate),
});
const range = (start: Rational, duration: Rational, rate: Rational) => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: rt(start, rate),
  duration: rt(duration, rate),
});
const esc = (value: string) => {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("Unsupported XML control character");
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
};
function checked(input: unknown, assets: ExportAssets, format: "otio" | "fcpxml"): TimelineIR {
  const ir = validateTimeline(input);
  for (const track of ir.tracks)
    for (const clip of track.clips) {
      if (clip.transition.kind !== "cut")
        throw new Error("Export crossfades require explicit overlap/handle semantics; bake or remove transition");
      if (clip.payload && Object.keys(clip.payload).length)
        throw new Error("Procedural/layout/audio automation payloads require baked assets before export");
      if (track.kind === "captions") continue;
      const asset = Object.hasOwn(assets, clip.assetId) ? assets[clip.assetId] : undefined;
      if (!asset) throw new Error(`Missing export asset ${clip.assetId}`);
      ExportAssetSchema.parse(asset);
      if (
        !path.isAbsolute(asset.path) ||
        !Number.isSafeInteger(asset.timebase.num) ||
        asset.timebase.num <= 0 ||
        !Number.isSafeInteger(asset.timebase.den) ||
        asset.timebase.den <= 0 ||
        compare(asset.durationFrames, fraction(0)) <= 0
      )
        throw new Error("Export asset needs absolute path, positive duration and source timebase");
      if (compare(asset.timebase, clip.source.timebase) !== 0 || compare(clip.source.end, asset.durationFrames) > 0)
        throw new Error("Source fps or trim disagrees with export asset");
      if (format === "fcpxml" && compare(clip.rate, fraction(1)) !== 0)
        throw new Error("FCPXML retiming is not supported by this verified subset; use OTIO or bake rate first");
    }
  return ir;
}
/** Exact rational caption sidecar is authoritative; SRT rounds outward to milliseconds. */
export function captionSidecars(input: unknown) {
  const compiled = compileTimelineIR(input);
  const captions = compiled.tracks
    .flatMap((track) =>
      track.clips.flatMap((clip) =>
        clip.captions.map((caption) => ({ ...caption, trackId: track.id, clipId: clip.id })),
      ),
    )
    .sort((a, b) => compare(a.start, b.start));
  const timestamp = (frame: Rational, end: boolean) => {
    const secs = seconds(frame, compiled.timebase);
    const ms = Number((BigInt(secs.num) * 1000n + (end ? BigInt(secs.den) - 1n : 0n)) / BigInt(secs.den));
    const hours = Math.floor(ms / 3600000),
      mins = Math.floor(ms / 60000) % 60,
      sec = Math.floor(ms / 1000) % 60;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return {
    exact: { version: 1, timebase: compiled.timebase, captions },
    srt: captions
      .map((c, index) => `${index + 1}\n${timestamp(c.start, false)} --> ${timestamp(c.end, true)}\n${c.text}\n`)
      .join("\n"),
  };
}
/** OTIO numeric fields are standard doubles; exact source/IR fractions are preserved in metadata. */
export function exportOtio(input: unknown, assets: ExportAssets): Record<string, unknown> {
  const ir = checked(input, assets, "otio");
  const tracks = ir.tracks
    .filter((track) => track.kind !== "captions")
    .map((track) => {
      let cursor = fraction(0);
      const children: Record<string, unknown>[] = [];
      for (const clip of [...track.clips].sort((a, b) => compare(a.start, b.start))) {
        const gap = sub(clip.start, cursor);
        if (gap.num > 0)
          children.push({
            OTIO_SCHEMA: "Gap.1",
            name: "Gap",
            source_range: range(fraction(0), gap, ir.timebase),
            effects: [],
            markers: [],
            metadata: {},
            enabled: true,
          });
        const asset = assets[clip.assetId]!;
        const duration = clipDuration(clip, ir.timebase);
        // Time effects do not alter OTIO item duration. Use displayed duration in source units.
        const displayedSourceDuration = mul(duration, div(clip.source.timebase, ir.timebase));
        children.push({
          OTIO_SCHEMA: "Clip.2",
          name: clip.id,
          enabled: true,
          source_range: range(clip.source.start, displayedSourceDuration, clip.source.timebase),
          active_media_reference_key: "DEFAULT_MEDIA",
          media_references: {
            DEFAULT_MEDIA: {
              OTIO_SCHEMA: "ExternalReference.1",
              target_url: pathToFileURL(asset.path).href,
              available_range: range(fraction(0), asset.durationFrames, asset.timebase),
              metadata: { assetId: clip.assetId },
            },
          },
          effects:
            compare(clip.rate, fraction(1)) === 0
              ? []
              : [
                  {
                    OTIO_SCHEMA: "LinearTimeWarp.1",
                    name: "Playback rate",
                    effect_name: "LinearTimeWarp",
                    time_scalar: numeric(clip.rate),
                    metadata: { exactRate: clip.rate },
                  },
                ],
          markers: [],
          metadata: { aiVideoCreator: { exactClip: clip, exactOutputDuration: duration, sourceEnd: clip.source.end } },
        });
        cursor = add(clip.start, duration);
      }
      return {
        OTIO_SCHEMA: "Track.1",
        name: track.id,
        kind: ["voiceover", "music", "sfx"].includes(track.kind) ? "Audio" : "Video",
        children,
        source_range: null,
        effects: [],
        markers: [],
        metadata: { originalKind: track.kind },
      };
    });
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: ir.projectId,
    global_start_time: rt(fraction(0), ir.timebase),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "Tracks",
      children: tracks,
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
    },
    metadata: {
      aiVideoCreator: {
        exactIR: ir,
        captions: captionSidecars(ir).exact,
        captionsDelivery: "exact JSON + SRT sidecars; no native karaoke conversion",
      },
    },
  };
}
/** FCPXML 1.10 connected-lane cut-only subset with per-source frameDuration. */
export function exportFcpxml(
  input: unknown,
  assets: ExportAssets,
  options: { width?: number; height?: number } = {},
): string {
  const ir = checked(input, assets, "fcpxml");
  const compiled = compileTimelineIR(ir);
  if (compiled.duration.num <= 0) throw new Error("Cannot export an empty FCPXML timeline");
  const width = options.width ?? 1920,
    height = options.height ?? 1080;
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0)) throw new Error("Invalid export dimensions");
  const used = [
    ...new Set(ir.tracks.filter((t) => t.kind !== "captions").flatMap((t) => t.clips.map((c) => c.assetId))),
  ];
  const ids = new Map(used.map((id, i) => [id, `a${i + 1}`]));
  const resources = used
    .map((id, index) => {
      const asset = assets[id]!;
      const video = asset.kind !== "audio";
      return `${video ? `<format id="f${index + 1}" frameDuration="${time(fraction(1), asset.timebase)}" width="${asset.width ?? width}" height="${asset.height ?? height}"/>` : ""}<asset id="${ids.get(id)}" name="${esc(id)}" start="0s" duration="${time(asset.durationFrames, asset.timebase)}" ${video ? `hasVideo="1" format="f${index + 1}"${asset.hasAudio ? ' hasAudio="1" audioSources="1" audioChannels="2"' : ""}` : 'hasAudio="1" audioSources="1" audioChannels="2"'}><media-rep kind="original-media" src="${esc(pathToFileURL(asset.path).href)}"/></asset>`;
    })
    .join("\n");
  let videoLane = 1,
    audioLane = -1;
  const clips = ir.tracks
    .filter((t) => t.kind !== "captions")
    .flatMap((track) => {
      const audio = ["voiceover", "music", "sfx"].includes(track.kind);
      const lane = audio ? audioLane-- : videoLane++;
      return track.clips.map(
        (clip) =>
          `<asset-clip name="${esc(clip.id)}" ref="${ids.get(clip.assetId)}" lane="${lane}" offset="${time(clip.start, ir.timebase)}" start="${time(clip.source.start, clip.source.timebase)}" duration="${time(clipDuration(clip, ir.timebase), ir.timebase)}" ${audio ? 'audioRole="dialogue"' : 'videoRole="video"'}/>`,
      );
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources><format id="timelineFormat" frameDuration="${time(fraction(1), ir.timebase)}" width="${width}" height="${height}"/>\n${resources}</resources><library><event name="Agent Bros. Pictures"><project name="${esc(ir.projectId)}"><sequence format="timelineFormat" duration="${time(compiled.duration, ir.timebase)}" tcStart="0s" tcFormat="NDF"><spine><gap name="Timeline anchor" offset="0s" start="0s" duration="${time(compiled.duration, ir.timebase)}">${clips}</gap></spine></sequence></project></event></library></fcpxml>\n`;
}
