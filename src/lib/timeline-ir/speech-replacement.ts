import type { SpeechReplacementEdit, TimelineClip, TimelineIR, Rational } from "../../types/timeline";
import { clipDuration, outputToSource, sourceToOutput } from "./compiler";
import { add, sub, compare, fraction } from "./rational";

function keepWords(clip: TimelineClip, start: Rational, end: Rational, timebase: Rational) {
  return clip.captions.filter((word) => {
    if (compare(word.end, clip.source.start) <= 0 || compare(word.start, clip.source.end) >= 0) return true;
    const from = sourceToOutput(clip, word.start, timebase),
      to = sourceToOutput(clip, word.end, timebase);
    if (compare(to, start) <= 0 || compare(from, end) >= 0) return true;
    if (compare(from, start) < 0 || compare(to, end) > 0) throw Error("Speech replacement cuts through a caption word");
    return false;
  });
}

export function replaceSpeechOnTimeline(
  ir: TimelineIR,
  track: TimelineIR["tracks"][number],
  clip: TimelineClip,
  edit: SpeechReplacementEdit,
) {
  const { timebase } = ir,
    { start, end, replacementId, assetId, captions } = edit;
  const presenter = track.kind === "presenter";
  const embeddedPresenter =
    presenter || (ir.legacyProject?.talkingHead as { audioSource?: string } | undefined)?.audioSource === "embedded";
  if (!presenter && track.kind !== "voiceover") throw Error("Select a presenter or voiceover clip");
  if (edit.pictureAssetId && !presenter) throw Error("A replacement picture requires a presenter clip");
  const endOfClip = add(clip.start, clipDuration(clip, timebase));
  if (compare(start, clip.start) < 0 || compare(end, endOfClip) > 0 || compare(start, end) >= 0)
    throw Error("Speech replacement must fit inside the selected clip");
  if (clip.transition.kind !== "cut" || clip.payload?.loop === true || clip.payload?.speechMuted === true)
    throw Error("Choose an unmuted, non-looping speech clip with a cut transition");
  const duration = sub(end, start);
  if (captions.some((word) => compare(word.start, fraction(0)) < 0 || compare(word.end, duration) > 0))
    throw Error("Replacement captions exceed the conformed audio window");
  let captionTrackFound = false;
  for (const other of ir.tracks) {
    if (other.id === edit.captionTrackId && other.kind === "captions") captionTrackFound = true;
    for (const candidate of other.clips) {
      if (
        candidate === clip ||
        compare(candidate.start, end) >= 0 ||
        compare(add(candidate.start, clipDuration(candidate, timebase)), start) <= 0
      )
        continue;
      if (
        other.kind === "voiceover" ||
        (other.kind === "presenter" && candidate.payload?.speechMuted !== true && embeddedPresenter)
      )
        throw Error("Another speech clip overlaps the proposed replacement");
      if (!candidate.captions.length) continue;
      const kept = keepWords(candidate, start, end, timebase);
      if (kept.length === candidate.captions.length) continue;
      if (other.kind !== "captions" || other.id !== edit.captionTrackId)
        throw Error("Declare the caption track owning words in this window");
      candidate.captions = kept;
    }
  }
  if (edit.captionTrackId && !captionTrackFound) throw Error("Replacement caption track is missing");
  const kept = keepWords(clip, start, end, timebase);
  const allowedTrim = presenter ? {} : { payload: { ...clip.payload, allowSpeechTrim: true } };
  const sourceStart = outputToSource(clip, start, timebase),
    sourceEnd = outputToSource(clip, end, timebase);
  const before =
    compare(start, clip.start) > 0
      ? [
          {
            ...clip,
            ...allowedTrim,
            source: { ...clip.source, end: sourceStart },
            captions: kept.filter((word) => compare(word.end, sourceStart) <= 0),
          },
        ]
      : [];
  const after =
    compare(end, endOfClip) < 0
      ? [
          {
            ...clip,
            ...allowedTrim,
            id: before.length ? `${replacementId}-after` : clip.id,
            start: end,
            source: { ...clip.source, start: sourceEnd },
            captions: kept.filter((word) => compare(word.start, sourceEnd) >= 0),
          },
        ]
      : [];
  const newSource = { start: fraction(0), end: duration, timebase };
  const replacement: TimelineClip = {
    id: replacementId,
    assetId,
    start,
    source: newSource,
    rate: fraction(1),
    transition: { kind: "cut" },
    captions,
    ...(typeof clip.payload?.volume === "number" ? { payload: { volume: clip.payload.volume } } : {}),
  };
  if (presenter) {
    const picture: TimelineClip = {
      ...clip,
      id: `${replacementId}-picture`,
      start,
      captions: [],
      payload: { ...clip.payload, speechMuted: true },
      ...(edit.pictureAssetId
        ? { assetId: edit.pictureAssetId, source: newSource, rate: fraction(1) }
        : { source: { ...clip.source, start: sourceStart, end: sourceEnd } }),
    };
    track.clips.splice(track.clips.indexOf(clip), 1, ...before, picture, ...after);
    const voice = ir.tracks.find((row) => row.kind === "voiceover");
    if (voice) voice.clips.push(replacement);
    else ir.tracks.push({ id: "speech-replacements", kind: "voiceover", clips: [replacement] });
  } else track.clips.splice(track.clips.indexOf(clip), 1, ...before, replacement, ...after);
}
