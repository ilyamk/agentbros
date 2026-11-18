import { z } from "zod";
import type { TimelineIR } from "../../types/timeline";
import { compileTimelineIR } from "../timeline-ir/compiler";
import { numeric } from "../timeline-ir/rational";
export const CaptionDeliveryProfileSchema = z
  .object({
    maxCharsPerLine: z.number().int().min(8).max(80).default(42),
    maxLines: z.number().int().min(1).max(3).default(2),
    maxWords: z.number().int().min(1).max(20).default(8),
    maxDurationSec: z.number().min(0.25).max(10).default(4),
    gapSec: z.number().min(0).max(2).default(0.5),
  })
  .strict();
export type CaptionCue = {
  id: string;
  startMs: number;
  endMs: number;
  lines: string[];
  wordIds: string[];
};
const time = (ms: number, separator: string) => {
  const rounded = Math.round(ms),
    h = Math.floor(rounded / 3600000),
    m = Math.floor(rounded / 60000) % 60,
    s = Math.floor(rounded / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${separator}${String(rounded % 1000).padStart(3, "0")}`;
};
/** Exact compiled source/output mapping owns subtitles; timestamps are rounded only at delivery. */
export function captionCues(
  ir: TimelineIR,
  options: {
    trackId?: string;
    profile?: z.input<typeof CaptionDeliveryProfileSchema>;
  } = {},
): CaptionCue[] {
  const profile = CaptionDeliveryProfileSchema.parse(options.profile ?? {}),
    snapshot = compileTimelineIR(ir);
  const tracks = snapshot.tracks.filter((track) => !options.trackId || track.id === options.trackId);
  if (options.trackId && !tracks.length) throw new Error("Requested caption track does not exist");
  const words = tracks
    .flatMap((track) => track.clips.flatMap((clip) => clip.captions.map((word) => ({ ...word, owner: track.id }))))
    .sort((a, b) => numeric(a.start) - numeric(b.start));
  const merged: typeof words = [];
  for (const word of words) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.id === word.id &&
      previous.owner === word.owner &&
      previous.text === word.text &&
      Math.abs(numeric(previous.end) - numeric(word.start)) < 1e-9
    )
      previous.end = word.end;
    else merged.push({ ...word });
  }
  const cues: CaptionCue[] = [];
  let current: CaptionCue | undefined;
  let previousEndMs = -1;
  for (const word of merged) {
    const startMs = Math.round((numeric(word.start) / numeric(snapshot.timebase)) * 1000),
      endMs = Math.round((numeric(word.end) / numeric(snapshot.timebase)) * 1000);
    if (!word.text.trim()) continue;
    if (endMs <= startMs) throw new Error("Caption word is shorter than delivery timestamp precision");
    if (startMs < previousEndMs)
      throw new Error("Overlapping caption words/owners require an explicit track or corrected source alignment");
    previousEndMs = endMs;
    if (endMs - startMs > profile.maxDurationSec * 1000)
      throw new Error("One caption word exceeds maximum cue duration");
    const lastLine = current?.lines.at(-1) ?? "";
    const candidate = lastLine ? `${lastLine} ${word.text}` : word.text;
    const breakCue =
      !current ||
      startMs - current.endMs > profile.gapSec * 1000 ||
      endMs - current.startMs > profile.maxDurationSec * 1000 ||
      current.wordIds.length >= profile.maxWords ||
      (candidate.length > profile.maxCharsPerLine && current.lines.length >= profile.maxLines);
    if (breakCue) {
      current = {
        id: word.id,
        startMs,
        endMs,
        lines: [word.text],
        wordIds: [word.id],
      };
      cues.push(current);
    } else {
      current!.endMs = endMs;
      current!.wordIds.push(word.id);
      if (candidate.length > profile.maxCharsPerLine) current!.lines.push(word.text);
      else current!.lines[current!.lines.length - 1] = candidate;
    }
    if (word.text.length > profile.maxCharsPerLine)
      throw new Error(`Unbreakable word exceeds caption line limit: ${word.text}`);
    if (/[.!?…]$/.test(word.text)) current = undefined;
  }
  return cues;
}
export function subtitleText(cues: CaptionCue[], format: "srt" | "vtt"): string {
  return (
    (format === "vtt" ? "WEBVTT\n\n" : "") +
    cues
      .map(
        (cue, index) =>
          `${format === "srt" ? index + 1 : `${index + 1}-${cue.id}`.replace(/[\r\n]/g, "_").replace(/-->/g, "→")}\n${time(cue.startMs, format === "srt" ? "," : ".")} --> ${time(cue.endMs, format === "srt" ? "," : ".")}\n${cue.lines.map((line) => line.replace(/-->/g, "→").replace(/[\r\n]/g, " ")).join("\n")}\n`,
      )
      .join("\n")
  );
}
