import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Rational = { num: number; den: number };
type JournalClip = { id: string; source?: { start: Rational; end: Rational; timebase: Rational } };
type Journal = { revision: number; timeline: { tracks: Array<{ id: string; kind: string; clips: JournalClip[] }> } };

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function fpsTimebase(fps: number): Rational {
  return Number.isInteger(fps) ? { num: fps, den: 1 } : { num: Math.round(fps * 1000), den: 1000 };
}

/** Keeps a clip's span when a full-composition re-render still contains it, since frame numbers are unchanged. */
function sourceFor(clip: JournalClip | undefined, timebase: Rational, frameCount: number, fullComposition: boolean) {
  const whole = { start: { num: 0, den: 1 }, end: { num: frameCount, den: 1 }, timebase };
  const span = clip?.source;
  if (!span || !fullComposition) return whole;
  const sameRate = span.timebase.num * timebase.den === timebase.num * span.timebase.den;
  return sameRate && span.end.num / span.end.den <= frameCount
    ? { start: span.start, end: span.end, timebase: span.timebase }
    : whole;
}

/**
 * The `timeline:edit` calls that bind an imported render. Nothing is executed: the commands are dry runs
 * for the caller to review. Unnamed clips stay as visible <placeholders>, with the available clips listed.
 */
export function nextTimelineCommands(options: {
  projectId: string;
  rootDir?: string;
  assetId: string;
  fps: number;
  frameCount: number;
  fullComposition: boolean;
  trackId?: string;
  clipIds?: string[];
}) {
  const { projectId, assetId, fps, frameCount, fullComposition, clipIds = [] } = options;
  const file = path.resolve(options.rootDir ?? ".", "public", "projects", projectId, "pipeline", "timeline-edit.json");
  const journal = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Journal) : undefined;
  const visualTracks = journal?.timeline.tracks.filter((track) => track.kind === "visual") ?? [];
  const onlyTrack = visualTracks.length === 1 ? visualTracks[0]!.id : undefined;
  const trackId = options.trackId ?? onlyTrack ?? "<trackId>";
  const track = visualTracks.find((candidate) => candidate.id === trackId);
  const timebase = fpsTimebase(fps);
  const replace = (clipId: string) => ({
    type: "replace",
    trackId,
    clipId,
    assetId,
    source: sourceFor(
      track?.clips.find((clip) => clip.id === clipId),
      timebase,
      frameCount,
      fullComposition,
    ),
  });
  const named = clipIds.length ? clipIds : ["<clipId>"];
  const command = named.length === 1 ? replace(named[0]!) : { type: "batch", commands: named.map(replace) };
  const frames = (span: { start: Rational; end: Rational }) =>
    span.end.num / span.end.den - span.start.num / span.start.den;
  const durationChanges = track
    ? clipIds.flatMap((clipId) => {
        const clip = track.clips.find((candidate) => candidate.id === clipId);
        const toFrames = frames(replace(clipId).source);
        return clip?.source && frames(clip.source) !== toFrames
          ? [{ clipId, fromFrames: frames(clip.source), toFrames }]
          : [];
      })
    : [];
  const prefix = `pnpm timeline:edit --project ${projectId}`;
  const commands = [
    ...(journal ? [] : [`${prefix} --init`]),
    `${prefix} --revision ${journal?.revision ?? 0} --command ${shellQuote(JSON.stringify(command))} --dry-run`,
  ];
  return {
    commands,
    resolved: !commands.some((line) => line.includes("<trackId>") || line.includes("<clipId>")),
    missingClips: track ? clipIds.filter((id) => !track.clips.some((clip) => clip.id === id)) : [],
    /** A replace can pass validation yet shorten a clip and leave a gap on its track. */
    durationChanges,
    visualClips: visualTracks.flatMap((candidate) =>
      candidate.clips.map((clip) => ({ trackId: candidate.id, clipId: clip.id })),
    ),
  };
}
