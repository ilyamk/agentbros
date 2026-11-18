import {
  RhythmEvidenceSchema,
  ReviewedRhythmMarksSchema,
  type RhythmEvidence,
  type ReviewedRhythmMarks,
  RhythmMappedRowSchema,
} from "../../types/rhythm-evidence";
import { validateTimeline, sourceToOutput } from "../timeline-ir/compiler";
import { fraction, compare, div } from "../timeline-ir/rational";
import { rhythmDigest } from "./rhythm-files";
import { validateRhythmClockSummary } from "./rhythm-clock";
/** Pure exact geometry only. Supplied review is data; never audibility/metrical truth or an edit. */
export function mapReviewedRhythmMarks(
  rawEvidence: RhythmEvidence,
  rawRequest: ReviewedRhythmMarks,
  rawTimeline: unknown,
) {
  const evidence = RhythmEvidenceSchema.parse(rawEvidence),
    request = ReviewedRhythmMarksSchema.parse(rawRequest),
    timeline = validateTimeline(rawTimeline);
  const { sha256, ...payload } = evidence;
  if (rhythmDigest(payload) !== sha256) throw Error("Rhythm evidence payload digest changed");
  validateRhythmClockSummary(evidence.clock);
  if (
    evidence.analysis.sourceSha256 !== evidence.request.assetSha256 ||
    evidence.original.sha256 !== evidence.request.assetSha256 ||
    evidence.analysis.durationSec !== evidence.clock.analysisSamples / 16000
  )
    throw Error("Rhythm source/analysis summary binding differs");
  const onsetIds = new Set<string>();
  let priorOnset = -1;
  for (const onset of evidence.onsets) {
    if (onsetIds.has(onset.id) || onset.sample <= priorOnset || onset.sample >= evidence.clock.analysisSamples)
      throw Error("Rhythm onset identity/order/extent invalid");
    onsetIds.add(onset.id);
    priorOnset = onset.sample;
  }
  if (request.projectId !== evidence.request.projectId || request.projectId !== timeline.projectId)
    throw Error("Rhythm project binding mismatch");
  const tracks = timeline.tracks.filter((t) => t.id === request.trackId);
  if (tracks.length !== 1 || tracks[0].kind !== "music") throw Error("Rhythm marks require explicit music track");
  const clips = tracks[0].clips.filter((c) => c.id === request.clipId);
  if (clips.length !== 1) throw Error("Rhythm selected clip missing/ambiguous");
  const clip = clips[0];
  if (
    clip.assetId !== evidence.request.assetId ||
    clip.transition.kind !== "cut" ||
    (clip.payload?.loop !== undefined && clip.payload.loop !== false)
  )
    throw Error("Rhythm marks require matching non-looping cut audio source");
  if (compare(div(clip.source.end, clip.source.timebase), evidence.clock.duration) > 0)
    throw Error("Rhythm clip extends beyond physical decoded source");
  const ids = new Set<string>();
  let previous = -1;
  const rows = request.marks.map((mark) => {
    if (ids.has(mark.id)) throw Error("Duplicate rhythm mark ID");
    ids.add(mark.id);
    const sample =
      mark.origin === "manual-reviewed-mark" ? mark.sample : evidence.onsets.find((o) => o.id === mark.onsetId)?.sample;
    if (sample === undefined || sample < 0 || sample >= evidence.clock.analysisSamples || sample <= previous)
      throw Error("Rhythm marks must be ordered unique actual source samples");
    previous = sample;
    const sourceFrame = fraction(
        BigInt(sample) * BigInt(clip.source.timebase.num),
        16000n * BigInt(clip.source.timebase.den),
      ),
      base = { id: mark.id, origin: mark.origin, sample, sourceFrame };
    if (compare(sourceFrame, clip.source.start) < 0 || compare(sourceFrame, clip.source.end) >= 0)
      return RhythmMappedRowSchema.parse({ ...base, status: "outside-source-trim" });
    const outputFrame = sourceToOutput(clip, sourceFrame, timeline.timebase);
    return RhythmMappedRowSchema.parse({
      ...base,
      status: "included",
      outputFrame,
      outputSeconds: div(outputFrame, timeline.timebase),
    });
  });
  return {
    rows,
    included: rows.filter((r) => r.status === "included").length,
    excluded: rows.filter((r) => r.status === "outside-source-trim").length,
    clipSha256: rhythmDigest({ timebase: timeline.timebase, trackId: tracks[0].id, kind: tracks[0].kind, clip }),
  };
}
