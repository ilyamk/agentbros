import { existsSync } from "node:fs";
import path from "node:path";
import type { Transcript } from "../../types/transcript";
import type { Rational, TimelineIR, TimelineClip } from "../../types/timeline";
import type { ProtectedSpan } from "../../types/longform";
import type { SpeechMask } from "../../types/speech-mask";
import {
  SHORTS_AXES,
  ShortsCandidatesSchema,
  ShortsProposalsSchema,
  ShortsWeightsSchema,
  type ShortsCandidate,
  type ShortsPrepared,
  type ShortsProposals,
  type ShortsScored,
  type ShortsWeights,
} from "../../types/shorts";
import { hashFile } from "../assets/registry";
import { stableHash, selectionHash } from "../longform/plans";
import { validateContext } from "../longform/slice";
import { clipDuration, outputToSource, sourceToOutput } from "../timeline-ir/compiler";
import { add, compare, fraction, numeric } from "../timeline-ir/rational";
import type { ShortsSentence } from "./prepare";

export const DEFAULT_WEIGHTS: ShortsWeights = {
  hook: 3,
  standalone: 2,
  emotion: 1,
  payoff: 2,
  value: 1.5,
  relevance: 1,
};
export const DEFAULT_THRESHOLD = 60;
export const PAD_MIN_SEC = 0.15;
export const PAD_MAX_SEC = 0.3;
export const HOOK_WINDOW_SEC = 3;
export const LONG_PAYOFF_MIN = 8;
export const MAX_OVERLAP = 0.5;

const DANGLING_OPENERS = [
  "he",
  "she",
  "they",
  "him",
  "her",
  "them",
  "it",
  "that",
  "this",
  "those",
  "these",
  "as i said",
  "like i said",
  "and",
  "but",
  "so",
  "because",
  "which",
  "он",
  "она",
  "они",
  "его",
  "её",
  "их",
  "это",
  "этот",
  "эта",
  "то",
  "как я говорил",
  "как я сказал",
  "и",
  "но",
  "а",
  "поэтому",
  "потому что",
  "который",
];

export function normaliseText(text: string) {
  return text
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}
const stripEdges = (text: string) => text.replace(/^[\s"'.,!?;:…-]+|[\s"'.,!?;:…-]+$/gu, "");
const wordCount = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Verbatim after Unicode, case, quote/dash and whitespace normalisation; at least three words or the whole sentence. */
export function quoteInSentence(quote: string, sentence: string) {
  const q = stripEdges(normaliseText(quote)),
    s = normaliseText(sentence);
  if (!q || !s.includes(q)) return false;
  return wordCount(q) >= Math.min(3, wordCount(stripEdges(s)));
}

export function weightedScore(axes: ShortsCandidate["axes"], weights: ShortsWeights) {
  const total = SHORTS_AXES.reduce((sum, axis) => sum + weights[axis], 0);
  const raw = SHORTS_AXES.reduce((sum, axis) => sum + weights[axis] * axes[axis].score, 0);
  return Math.round((raw / total) * 100) / 10;
}

const EPS = 1e-6;
export const MIN_EDGE_SILENCE_SEC = 0.1;
export const EDGE_SEARCH_SEC = 0.15;
export type Snap = {
  startSec: number;
  endSec: number;
  previousEnd: number;
  nextStart: number;
  warnings: string[];
  runningEdges: string[];
};
type Spans = SpeechMask["speech"];

/** Silences of at least `min` seconds between the mask's speech spans. */
const maskSilences = (mask: Spans, min: number) =>
  mask
    .slice(1)
    .map((span, i) => ({ startSec: mask[i]!.endSec, endSec: span.startSec }))
    .filter((gap) => gap.endSec - gap.startSec >= min - EPS);

/**
 * Clip edges at the first and last spoken word of the sentence range, padded into the surrounding silence. With a
 * speech mask, an edge also moves out to the voice-activity edge of that speech when the edge lies in the word gap
 * (speech the mask runs on into the next word is no edge), and the padding stops at the mask's neighbouring speech.
 * An edge with less than 100 ms between words is running speech: with a mask it moves into the nearest mask silence
 * of at least 100 ms within 150 ms of the word gap;
 * otherwise it is listed in `runningEdges` and the caller rejects the clip. The start and end of the file never count.
 */
export function snapToSentences(
  transcript: Transcript,
  first: ShortsSentence,
  last: ShortsSentence,
  mask?: Spans,
): Snap {
  const words = transcript.words;
  const index = new Map(words.map((w, i) => [w.id, i]));
  const from = index.get(first.firstWordId),
    to = index.get(last.lastWordId);
  if (from === undefined || to === undefined || to < from)
    throw new Error(`Sentence words missing for S${first.n}–S${last.n}`);
  let a = from,
    b = to;
  while (a < b && words[a]!.kind !== "word") a++;
  while (b > a && words[b]!.kind !== "word") b--;
  const warnings: string[] = [],
    runningEdges: string[] = [];
  const startWord = words[a]!,
    endWord = words[b]!;
  const durationSec = transcript.source.durationSec ?? endWord.endSec + PAD_MAX_SEC;
  let previousEnd = a > 0 ? words[a - 1]!.endSec : 0;
  let nextStart = b < words.length - 1 ? words[b + 1]!.startSec : durationSec;
  let hasPrevious = a > 0,
    hasNext = b < words.length - 1;
  let speechStart = startWord.startSec,
    speechEnd = endWord.endSec;
  if (mask) {
    const atStart = mask.find((s) => s.startSec < startWord.endSec && s.endSec > startWord.startSec);
    if (atStart && atStart.startSec < speechStart && (a === 0 || atStart.startSec > previousEnd))
      speechStart = atStart.startSec;
    const atEnd = mask.find((s) => s.startSec < endWord.endSec && s.endSec > endWord.startSec);
    if (atEnd && atEnd.endSec > speechEnd && (b === words.length - 1 || atEnd.endSec < nextStart))
      speechEnd = atEnd.endSec;
    const before = mask.filter((s) => s.endSec <= speechStart + EPS).at(-1);
    const after = mask.find((s) => s.startSec >= speechEnd - EPS);
    if (before && before.endSec > previousEnd) previousEnd = before.endSec;
    if (after && after.startSec < nextStart) nextStart = after.startSec;
    hasPrevious ||= Boolean(before);
    hasNext ||= Boolean(after);
  }
  const silences = mask ? maskSilences(mask, MIN_EDGE_SILENCE_SEC) : [];
  if (hasPrevious && speechStart - previousEnd < MIN_EDGE_SILENCE_SEC - EPS) {
    const lo = Math.min(previousEnd, speechStart) - EDGE_SEARCH_SEC,
      hi = speechStart + EDGE_SEARCH_SEC;
    const gap = silences
      .filter((g) => g.endSec > lo && g.startSec < hi)
      .sort((x, y) => Math.abs(x.endSec - speechStart) - Math.abs(y.endSec - speechStart))[0];
    if (gap) {
      warnings.push(
        `start placed in the speech mask's ${Math.round((gap.endSec - gap.startSec) * 1000)} ms silence (${Math.round(Math.max(0, speechStart - previousEnd) * 1000)} ms between the words)`,
      );
      previousEnd = gap.startSec;
      speechStart = gap.endSec;
    } else
      runningEdges.push(
        `starts in running speech: ${Math.round(Math.max(0, speechStart - previousEnd) * 1000)} ms of silence before the first word${mask ? " and no mask silence nearby" : "; try --speech-mask or another first sentence"}`,
      );
  }
  if (hasNext && nextStart - speechEnd < MIN_EDGE_SILENCE_SEC - EPS) {
    const lo = speechEnd - EDGE_SEARCH_SEC,
      hi = Math.max(nextStart, speechEnd) + EDGE_SEARCH_SEC;
    const gap = silences
      .filter((g) => g.endSec > lo && g.startSec < hi)
      .sort((x, y) => Math.abs(x.startSec - speechEnd) - Math.abs(y.startSec - speechEnd))[0];
    if (gap) {
      warnings.push(
        `end placed in the speech mask's ${Math.round((gap.endSec - gap.startSec) * 1000)} ms silence (${Math.round(Math.max(0, nextStart - speechEnd) * 1000)} ms between the words)`,
      );
      speechEnd = gap.startSec;
      nextStart = gap.endSec;
    } else
      runningEdges.push(
        `ends in running speech: ${Math.round(Math.max(0, nextStart - speechEnd) * 1000)} ms of silence after the last word${mask ? " and no mask silence nearby" : "; try --speech-mask or another last sentence"}`,
      );
  }
  const startPad = Math.min(PAD_MAX_SEC, Math.max(0, speechStart - previousEnd) / (hasPrevious ? 2 : 1));
  const endPad = Math.min(PAD_MAX_SEC, Math.max(0, nextStart - speechEnd) / (hasNext ? 2 : 1));
  if (startPad < PAD_MIN_SEC && !runningEdges.some((r) => r.startsWith("starts")))
    warnings.push(`tight start: ${Math.round(startPad * 1000)} ms of padding before the first word`);
  if (endPad < PAD_MIN_SEC && !runningEdges.some((r) => r.startsWith("ends")))
    warnings.push(`tight end: ${Math.round(endPad * 1000)} ms of padding after the last word`);
  return {
    startSec: round(speechStart - startPad),
    endSec: round(speechEnd + endPad),
    previousEnd,
    nextStart: hasNext ? nextStart : Number.POSITIVE_INFINITY,
    warnings,
    runningEdges,
  };
}
const round = (sec: number) => Math.round(sec * 1000) / 1000;

export const overlapRatio = (a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }) => {
  const intersection = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (intersection <= 0) return 0;
  return intersection / Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
};

export type TimelineSource = {
  ir: TimelineIR;
  projectId: string;
  projectDir: string;
  protectedSpans: ProtectedSpan[];
  trackId?: string;
  assetId?: string;
};
type Located = { trackId: string; clips: TimelineClip[]; assetId: string };

/**
 * Clips of the recording on the timeline: `--asset`, assetId `sha256:<hash>`, a recording-edit clip whose
 * `payload.sourceHash` is the transcript's (its normalised master keeps the source clock), or a public file with that hash.
 * Joined speech audio runs on the output clock, so it never matches by sourceHash.
 */
export function locateRecording(source: TimelineSource, sourceSha256: string, publicDir: string): Located {
  const hashes = new Map<string, string | null>();
  const matches = (clip: TimelineClip) => {
    if (source.assetId) return clip.assetId === source.assetId;
    if (clip.assetId === `sha256:${sourceSha256}`) return true;
    if (clip.payload?.sourceHash === sourceSha256 && !clip.payload.joinedSpeech && !clip.assetId.startsWith("caption:"))
      return true;
    if (!hashes.has(clip.assetId)) {
      const file = path.resolve(publicDir, clip.assetId);
      hashes.set(clip.assetId, file.startsWith(publicDir + path.sep) && existsSync(file) ? hashFile(file) : null);
    }
    return hashes.get(clip.assetId) === sourceSha256;
  };
  const found = source.ir.tracks
    .filter((track) =>
      source.trackId ? track.id === source.trackId : ["presenter", "visual", "voiceover"].includes(track.kind),
    )
    .map((track) => ({
      trackId: track.id,
      clips: track.clips.filter(matches).sort((x, y) => compare(x.start, y.start)),
    }))
    .filter((track) => track.clips.length);
  if (!found.length) throw new Error("No timeline clip uses the transcribed recording; pass --asset or --track");
  const assets = new Set(found[0]!.clips.map((c) => c.assetId));
  if (assets.size > 1) throw new Error(`Several assets match on track ${found[0]!.trackId}; pass --asset`);
  return { ...found[0]!, assetId: [...assets][0]! };
}

const secondsToSource = (sec: number, timebase: Rational) =>
  fraction(BigInt(Math.round(sec * 1000)) * BigInt(timebase.num), BigInt(1000) * BigInt(timebase.den));
const floorR = (r: Rational) => fraction(Math.floor(r.num / r.den));
const ceilR = (r: Rational) => fraction(Math.ceil(r.num / r.den));

export type Removed = { startSec: number; endSec: number };
/**
 * One range in output frames, whole frames, never inside a neighbouring word. The span may cross several kept clips
 * of a recut when they follow each other on the output and in the source; `removed` lists the source spans the recut
 * cut out inside it, for the caller to check against the candidate's words.
 */
export function mapToTimeline(
  located: Located,
  timebase: Rational,
  snap: { startSec: number; endSec: number },
  guard: { previousEnd: number; nextStart: number },
): { range: { start: Rational; end: Rational }; removed: Removed[] } | { error: string } {
  const spans = located.clips.map((clip) => ({
    clip,
    sourceStart: numeric(clip.source.start) / numeric(clip.source.timebase),
    sourceEnd: numeric(clip.source.end) / numeric(clip.source.timebase),
    end: add(clip.start, clipDuration(clip, timebase)),
  }));
  const hits = spans
    .map((span, index) => ({ ...span, index }))
    .filter((span) => span.sourceEnd > snap.startSec + EPS && span.sourceStart < snap.endSec - EPS);
  if (!hits.length) return { error: "not on the timeline (removed by a recut)" };
  for (let i = 1; i < hits.length; i++) {
    const previous = hits[i - 1]!,
      current = hits[i]!;
    if (
      current.index !== previous.index + 1 ||
      compare(current.clip.start, previous.end) !== 0 ||
      current.sourceStart < previous.sourceEnd - EPS
    )
      return { error: "spans a reordered or interrupted part of the timeline; review by hand" };
  }
  const removed: Removed[] = [];
  const first = hits[0]!,
    last = hits[hits.length - 1]!;
  if (first.sourceStart > snap.startSec + EPS) removed.push({ startSec: snap.startSec, endSec: first.sourceStart });
  for (let i = 1; i < hits.length; i++)
    if (hits[i]!.sourceStart > hits[i - 1]!.sourceEnd + EPS)
      removed.push({ startSec: hits[i - 1]!.sourceEnd, endSec: hits[i]!.sourceStart });
  if (last.sourceEnd < snap.endSec - EPS) removed.push({ startSec: last.sourceEnd, endSec: snap.endSec });
  const startSec = Math.max(snap.startSec, first.sourceStart),
    endSec = Math.min(snap.endSec, last.sourceEnd);
  const toSec = (clip: TimelineClip, frame: Rational) =>
    numeric(outputToSource(clip, frame, timebase)) / numeric(clip.source.timebase);
  const s = sourceToOutput(first.clip, secondsToSource(startSec, first.clip.source.timebase), timebase);
  const e = sourceToOutput(last.clip, secondsToSource(endSec, last.clip.source.timebase), timebase);
  let start = floorR(s),
    end = ceilR(e);
  if (compare(start, first.clip.start) < 0 || toSec(first.clip, start) < guard.previousEnd - EPS) start = ceilR(s);
  if (compare(end, last.end) > 0 || toSec(last.clip, end) > guard.nextStart + EPS) end = floorR(e);
  if (compare(start, end) >= 0) return { error: "range shorter than one frame" };
  return { range: { start, end }, removed };
}

/** Word ids each quote covers; a quote that cannot be aligned word by word covers its whole sentence. */
export function quotedWordIds(transcript: Transcript, sentence: ShortsSentence, quote: string) {
  const index = new Map(transcript.words.map((w, i) => [w.id, i]));
  const words = transcript.words
    .slice(index.get(sentence.firstWordId)!, index.get(sentence.lastWordId)! + 1)
    .filter((w) => w.kind !== "event");
  const token = (text: string) => stripEdges(normaliseText(text));
  const tokens = words.map((w) => token(w.text));
  const wanted = token(quote).split(" ").map(token).filter(Boolean);
  for (let i = 0; i + wanted.length <= tokens.length; i++)
    if (wanted.every((t, j) => tokens[i + j] === t)) return words.slice(i, i + wanted.length).map((w) => w.id);
  return words.map((w) => w.id);
}

export type RankOptions = {
  weights?: ShortsWeights;
  threshold: number;
  thresholdSource: ShortsProposals["thresholdSource"];
  timeline?: TimelineSource;
  publicDir?: string;
  speechMask?: SpeechMask;
  preparedSha256: string;
  candidatesSha256: string;
};

export function rankCandidates(
  prepared: ShortsPrepared,
  transcript: Transcript,
  sentences: ShortsSentence[],
  rawCandidates: unknown,
  options: RankOptions,
): ShortsProposals {
  const weights = ShortsWeightsSchema.parse(options.weights ?? DEFAULT_WEIGHTS);
  const { candidates } = ShortsCandidatesSchema.parse(rawCandidates);
  if (options.speechMask && options.speechMask.source.sha256 !== transcript.source.sha256)
    throw new Error("Speech mask belongs to another recording than the transcript");
  const ids = new Set<string>();
  for (const c of candidates) {
    if (ids.has(c.id)) throw new Error(`Duplicate candidate id: ${c.id}`);
    ids.add(c.id);
  }
  const { minSec, maxSec, hardMaxSec } = prepared.params;
  const byNo = (n: number) => sentences[n - 1];
  const located = options.timeline
    ? locateRecording(options.timeline, transcript.source.sha256, options.publicDir ?? "")
    : null;
  const rejected: ShortsProposals["rejected"] = [];
  const scored: (ShortsScored & { selection?: NonNullable<ShortsProposals["proposals"][number]["selection"]> })[] = [];

  for (const c of candidates) {
    const reasons: string[] = [];
    const first = byNo(c.firstSentence),
      last = byNo(c.lastSentence),
      hook = byNo(c.hookSentence);
    if (!first || !last || !hook) {
      rejected.push({ id: c.id, reasons: [`sentence out of range 1–${sentences.length}`] });
      continue;
    }
    const inRange = (n: number) => n >= c.firstSentence && n <= c.lastSentence;
    if (!inRange(c.hookSentence)) reasons.push(`hookSentence S${c.hookSentence} outside the range`);
    for (const axis of SHORTS_AXES) {
      const evidence = c.axes[axis];
      if (!inRange(evidence.sentence))
        reasons.push(`${axis}: evidence sentence S${evidence.sentence} outside the range`);
      else if (!quoteInSentence(evidence.quote, byNo(evidence.sentence)!.text))
        reasons.push(`${axis}: quote not found verbatim in S${evidence.sentence}`);
    }
    if (c.axes.hook.sentence !== c.hookSentence) reasons.push("hook: evidence must come from hookSentence");
    if (c.axes.payoff.sentence < c.lastSentence - 1)
      reasons.push("payoff: evidence must come from one of the last two sentences");
    for (const [veto, on] of Object.entries(c.vetoes)) if (on) reasons.push(`veto: ${veto}`);
    if (reasons.length) {
      rejected.push({ id: c.id, reasons });
      continue;
    }
    const snap = snapToSentences(transcript, first, last, options.speechMask?.speech);
    const warnings = [...snap.warnings];
    reasons.push(...snap.runningEdges);
    const durationSec = round(snap.endSec - snap.startSec);
    if (hook.startSec - snap.startSec > HOOK_WINDOW_SEC)
      reasons.push(`hook starts ${(hook.startSec - snap.startSec).toFixed(1)} s in (limit ${HOOK_WINDOW_SEC} s)`);
    if (durationSec < minSec) reasons.push(`too short: ${durationSec} s < ${minSec} s`);
    else if (durationSec > hardMaxSec) reasons.push(`too long: ${durationSec} s > ${hardMaxSec} s`);
    else if (durationSec > maxSec) {
      if (c.axes.payoff.score < LONG_PAYOFF_MIN)
        reasons.push(`over ${maxSec} s without a story payoff (payoff ${c.axes.payoff.score} < ${LONG_PAYOFF_MIN})`);
      else warnings.push(`long clip (${durationSec} s) kept for its story payoff`);
    }
    const opener = normaliseText(first.text).replace(/^[^\p{L}\p{N}]+/u, "");
    const dangling = DANGLING_OPENERS.find(
      (w) => opener === w || opener.startsWith(`${w} `) || opener.startsWith(`${w},`),
    );
    if (dangling) warnings.push(`opens with "${dangling}": check that nothing before the range is needed`);

    let selection: (typeof scored)[number]["selection"];
    if (located && options.timeline) {
      const mapped = mapToTimeline(located, options.timeline.ir.timebase, snap, snap);
      if ("error" in mapped) reasons.push(`timeline: ${mapped.error}`);
      else if (mapped.removed.length) {
        const cut = transcript.words.filter(
          (w) =>
            w.kind !== "event" &&
            mapped.removed.some(
              (r) => (w.startSec + w.endSec) / 2 > r.startSec && (w.startSec + w.endSec) / 2 < r.endSec,
            ),
        );
        const quoted = new Set(
          SHORTS_AXES.flatMap((axis) => quotedWordIds(transcript, byNo(c.axes[axis].sentence)!, c.axes[axis].quote)),
        );
        const lost = cut.filter((w) => quoted.has(w.id));
        if (lost.length) reasons.push(`timeline: the recut removes quoted words: ${lost.map((w) => w.text).join(" ")}`);
        else
          warnings.push(
            `crosses ${mapped.removed.length} recut cut(s)${cut.length ? `, removing ${cut.map((w) => w.text).join(" ")}` : ""}`,
          );
      }
      if (!("error" in mapped) && !reasons.length) {
        try {
          validateContext([mapped.range], options.timeline.protectedSpans);
          selection = {
            version: 1,
            id: c.id,
            purpose: c.title,
            ranges: [mapped.range],
            selectionHash: selectionHash([mapped.range]),
          };
        } catch (error) {
          reasons.push(`protected context: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (reasons.length) {
      rejected.push({ id: c.id, reasons });
      continue;
    }
    scored.push({
      id: c.id,
      title: c.title,
      score: weightedScore(c.axes, weights),
      axes: c.axes,
      firstSentence: c.firstSentence,
      lastSentence: c.lastSentence,
      hookSentence: c.hookSentence,
      startSec: snap.startSec,
      endSec: snap.endSec,
      durationSec,
      text: sentences
        .slice(c.firstSentence - 1, c.lastSentence)
        .map((s) => s.text)
        .join(" "),
      warnings,
      ...(selection ? { selection } : {}),
    });
  }

  scored.sort((x, y) => y.score - x.score || x.startSec - y.startSec || x.id.localeCompare(y.id));
  const kept: typeof scored = [];
  const droppedOverlaps: ShortsProposals["droppedOverlaps"] = [];
  for (const item of scored) {
    const clash = kept.find((k) => overlapRatio(k, item) > MAX_OVERLAP);
    if (clash)
      droppedOverlaps.push({
        id: item.id,
        keptId: clash.id,
        overlap: Math.round(overlapRatio(clash, item) * 1000) / 1000,
      });
    else kept.push(item);
  }
  const proposals: ShortsProposals["proposals"] = [];
  const others: ShortsProposals["others"] = [];
  for (const item of kept) {
    if (item.score < options.threshold) {
      const { selection: _unused, ...rest } = item;
      others.push({ ...rest, reason: "below-threshold" });
    } else if (proposals.length >= prepared.params.count) {
      const { selection: _unused, ...rest } = item;
      others.push({ ...rest, reason: "over-count" });
    } else proposals.push({ ...item, rank: proposals.length + 1 });
  }
  return ShortsProposalsSchema.parse({
    version: 1,
    preparedSha256: options.preparedSha256,
    candidatesSha256: options.candidatesSha256,
    sourceSha256: transcript.source.sha256,
    weights,
    weightsHash: stableHash(weights),
    threshold: options.threshold,
    thresholdSource: options.thresholdSource,
    proposals,
    others,
    droppedOverlaps,
    rejected,
    timeline:
      located && options.timeline
        ? { projectId: options.timeline.projectId, trackId: located.trackId, assetId: located.assetId }
        : null,
  });
}

export function proposalsMarkdown(result: ShortsProposals) {
  const line = (p: ShortsScored) =>
    `- **${p.id}** ${p.score} · ${p.startSec}–${p.endSec} s (${p.durationSec} s) · S${p.firstSentence}–S${p.lastSentence}: ${p.title}${p.warnings.length ? `\n  - warnings: ${p.warnings.join("; ")}` : ""}`;
  return `# Shorts proposals

Threshold ${result.threshold} (${result.thresholdSource}); weights ${SHORTS_AXES.map((a) => `${a} ${result.weights[a]}`).join(", ")}. These are proposals, not approvals: a human watches each range and adds \`approval\` (approvedBy, approvedAt, selectionHash) before \`shorts-series\`.

## Proposed

${result.proposals.map(line).join("\n") || "None."}

## Others

${result.others.map((p) => `${line(p)} (${p.reason})`).join("\n") || "None."}

## Rejected

${result.rejected.map((r) => `- **${r.id}**: ${r.reasons.join("; ")}`).join("\n") || "None."}
${result.droppedOverlaps.length ? `\n## Dropped as overlapping\n\n${result.droppedOverlaps.map((d) => `- ${d.id} overlaps ${d.keptId} by ${Math.round(d.overlap * 100)}%`).join("\n")}\n` : ""}`;
}
