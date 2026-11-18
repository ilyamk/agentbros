import { createHash } from "node:crypto";
import type { Transcript, TranscriptWord } from "../../types/transcript";
import type { SpeechMask as VadSpeechMask } from "../../types/speech-mask";
import type { RecordingEditRequest } from "../../types/workflow-recording-edit";

/** Unpadded VAD speech spans from `speech:local`, as tuples; recut:plan adds its own padding. */
export const maskFromVad = (mask: VadSpeechMask): SpeechMask => ({
  speech: mask.speech.map((span) => [span.startSec, span.endSec] as [number, number]),
  sha256: mask.source.sha256,
});
export type SpeechMask = { speech: [number, number][]; sha256: string };

export type RecutOptions = {
  prePadMs: number;
  postPadMs: number;
  longPauseMs: number;
  midPauseMs: number;
  sentencePauseMs: number;
  fillers: boolean;
  retakes: boolean;
  fillerMinGapMs: number;
  maxRetakeExtraWords: number;
  crossfadeMs: number;
  snapSearchMs: number;
  roomTone: boolean;
  roomToneGainDb: number;
  /** A chosen room-tone span in source seconds (a reviewed candidate, e.g. sfx:find-segment --kind texture); implies roomTone. */
  roomToneSpan: { startSec: number; endSec: number } | null;
  punchIn: number | null;
  reject: string[];
};
export const DEFAULT_RECUT_OPTIONS: RecutOptions = {
  prePadMs: 120,
  postPadMs: 200,
  longPauseMs: 600,
  midPauseMs: 250,
  sentencePauseMs: 400,
  fillers: true,
  retakes: true,
  fillerMinGapMs: 30,
  maxRetakeExtraWords: 3,
  crossfadeMs: 15,
  snapSearchMs: 30,
  roomTone: false,
  roomToneGainDb: -6,
  roomToneSpan: null,
  punchIn: null,
  reject: [],
};

export type RecutSource = {
  file: string;
  sha256: string;
  version: string;
  fps: { num: number; den: number };
  /** Decoded frame boundaries in seconds (frames + 1 values); absent for 30fps constant-rate sources. */
  boundaries: number[] | null;
  frameCount: number;
};
export type RecutCandidate = {
  id: string;
  kind: "filler" | "retake" | "pause" | "head" | "tail";
  startSec: number;
  endSec: number;
  startFrame: number;
  endFrame: number;
  removedWordIds: string[];
  reason: string;
  evidence: string[];
  before: string;
  removed: string;
  after: string;
};
export type RecutRejection = { kind: RecutCandidate["kind"]; atSec: number; words: string; reason: string };
export type RecutPlan = {
  request: Extract<RecordingEditRequest, { version: 3 }>;
  cuts: RecutCandidate[];
  rejected: RecutRejection[];
  protectedSpans: (RecordingEditRequest["protectedSpans"][number] & { text: string })[];
  summary: {
    sourceSec: number;
    outputSec: number;
    removedSec: number;
    fillers: number;
    retakes: number;
    pauses: number;
    maskUsed: boolean;
    levelsUsed: boolean;
  };
};

const NEGATION = /^(не|нет|нельзя|ни|никогда|ничего|никто|без|not|never|no|nothing|nobody|none|without|cannot|.*n't)$/i;
const CAVEAT =
  /^(если|кроме|но|однако|хотя|только|возможно|может|unless|except|however|if|but|only|although|though|maybe|might|perhaps)$/i;
const ATTRIBUTION =
  /^(according|said|says|claims|reported|согласно|сказал|сказала|говорит|говорят|считает|утверждает|по-словам)$/i;
const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\p{P}\p{S}]/gu, "");
const ms = (value: number) => value / 1000;
const clock = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, "0")}:${(sec % 60).toFixed(3).padStart(6, "0")}`;

type Input = {
  transcript: Transcript;
  source: RecutSource;
  projectId: string;
  name: string;
  formats: ("vertical" | "square" | "landscape")[];
  mask: SpeechMask | null;
  /** RMS level of the source audio over [startSec, endSec) in dBFS. */
  levelDb: ((startSec: number, endSec: number) => number) | null;
  options?: Partial<RecutOptions>;
};

export function planRecut(input: Input): RecutPlan {
  const o = { ...DEFAULT_RECUT_OPTIONS, ...input.options };
  const { transcript, source, mask, levelDb } = input;
  if (transcript.source.sha256 !== source.sha256)
    throw new Error("Transcript belongs to a different source file (sha256 mismatch)");
  if (mask && mask.sha256 !== transcript.source.sha256)
    throw new Error("Speech mask belongs to a different source file (sha256 mismatch)");
  if (!transcript.words.length) throw new Error("Transcript has no words");
  if (transcript.words.length > 30000) throw new Error("Transcript exceeds 30000 words; split the recording");
  if (o.prePadMs < 80 || o.prePadMs > 150 || o.postPadMs < 150 || o.postPadMs > 250)
    throw new Error("Pads must stay within 80–150ms before and 150–250ms after a phrase");
  if (
    o.midPauseMs < 250 ||
    o.sentencePauseMs > 400 ||
    o.midPauseMs > o.sentencePauseMs ||
    o.longPauseMs <= o.sentencePauseMs
  )
    throw new Error("Shortened pauses must stay within 250–400ms and below the long-pause threshold");
  const duration = source.boundaries ? source.boundaries[source.frameCount] : source.frameCount / 30;
  const frameAt = (sec: number, mode: "floor" | "ceil" | "nearest") => {
    if (!source.boundaries) {
      const exact = sec * 30;
      const f =
        mode === "floor" ? Math.floor(exact + 1e-9) : mode === "ceil" ? Math.ceil(exact - 1e-9) : Math.round(exact);
      return Math.min(source.frameCount, Math.max(0, f));
    }
    const b = source.boundaries;
    let lo = 0,
      hi = source.frameCount;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (b[mid] <= sec + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    if (mode === "floor" || Math.abs(b[lo] - sec) <= 1e-9) return lo;
    if (mode === "ceil") return Math.min(source.frameCount, lo + 1);
    return lo + 1 <= source.frameCount && b[lo + 1] - sec < sec - b[lo] ? lo + 1 : lo;
  };
  const secAt = (frame: number) => (source.boundaries ? source.boundaries[frame] : frame / 30);

  const words = [...transcript.words].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  if (words.at(-1)!.endSec > duration + 0.05) throw new Error("Transcript extends past the end of the source");
  const frames: { start: number; end: number }[] = [];
  for (const word of words) {
    const previous = frames.at(-1)?.end ?? 0;
    const start = Math.max(frameAt(word.startSec, "nearest"), previous);
    frames.push({ start, end: Math.max(frameAt(Math.min(word.endSec, duration), "nearest"), start + 1) });
  }
  if (frames.at(-1)!.end > source.frameCount) throw new Error("Transcript words do not fit the decoded frames");
  const index = new Map(words.map((w, i) => [w.id, i]));
  const sentenceOf = new Array<number>(words.length).fill(-1);
  const declared = transcript.sentences.length
    ? transcript.sentences
    : words.reduce<{ id: string; firstWordId: string; lastWordId: string; text: string }[]>((list, word, i) => {
        const open = list.at(-1),
          previous = words[i - 1];
        if (open && previous && !/[.!?…]["»”)]*$/.test(previous.text) && word.startSec - previous.endSec < 1)
          Object.assign(open, { lastWordId: word.id, text: `${open.text} ${word.text}` });
        else list.push({ id: `s${list.length + 1}`, firstWordId: word.id, lastWordId: word.id, text: word.text });
        return list;
      }, []);
  const sentences = declared.map((sentence, s) => {
    const first = index.get(sentence.firstWordId),
      last = index.get(sentence.lastWordId);
    if (first === undefined || last === undefined || last < first)
      throw new Error(`Sentence ${sentence.id} references unknown or reversed words`);
    for (let i = first; i <= last; i++) sentenceOf[i] = s;
    return { first, last, text: sentence.text };
  });
  for (let i = 0; i < words.length; i++)
    if (sentenceOf[i] < 0) {
      sentenceOf[i] = sentences.length;
      sentences.push({ first: i, last: i, text: words[i].text });
    }
  const speechAt = (sec: number) => !!mask?.speech.some(([s, e]) => s <= sec && e > sec);
  const speechIn = (a: number, b: number) => !!mask?.speech.some(([s, e]) => s < b && e > a);
  const speechLevels = levelDb
    ? words
        .filter((w) => w.kind === "word" && w.endSec - w.startSec >= 0.05)
        .map((w) => levelDb(w.startSec, w.endSec))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
    : [];
  const speechDb = speechLevels.length ? speechLevels[Math.floor(speechLevels.length / 2)] : null;
  const gapLevels = levelDb
    ? words
        .slice(1)
        .flatMap((w, i) => {
          const out: number[] = [];
          for (let t = words[i].endSec + 0.02; t + 0.03 <= w.startSec; t += 0.01) out.push(levelDb(t, t + 0.01));
          return out;
        })
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
    : [];
  const floorDb = gapLevels.length >= 20 ? gapLevels[Math.floor(gapLevels.length * 0.2)] : null;
  /** A cut point is quiet when it is 18dB under the median word, or within 6dB of the room's floor while still 10dB under speech. */
  const cleanDb =
    speechDb === null
      ? null
      : Math.min(-30, speechDb - 10, Math.max(speechDb - 18, floorDb === null ? -Infinity : floorDb + 6));
  const pointEvidence = (sec: number, useMask = true): { clean: boolean; note: string } => {
    const notes: string[] = [];
    let clean = true;
    if (mask && useMask) {
      const voiced = speechIn(sec - 0.01, sec + 0.01);
      clean &&= !voiced;
      notes.push(voiced ? "VAD speech" : "VAD silent");
    }
    if (levelDb && cleanDb !== null) {
      const db = levelDb(sec - 0.01, sec + 0.01);
      clean &&= db <= cleanDb;
      notes.push(`${db.toFixed(0)} dBFS`);
    }
    return { clean, note: notes.join(", ") || "transcript gap only" };
  };
  const context = (from: number, to: number) => ({
    before: words
      .slice(Math.max(0, from - 6), from)
      .map((w) => w.text)
      .join(" "),
    removed: words
      .slice(from, to)
      .map((w) => w.text)
      .join(" "),
    after: words
      .slice(to, to + 6)
      .map((w) => w.text)
      .join(" "),
  });
  const rejected: RecutRejection[] = [];
  const removed = new Set<number>();
  const removalReason = new Map<number, { kind: "filler" | "retake"; text: string; evidence: string[] }>();

  // Last complete take wins: a repeated n-gram restart within a sentence, or a whole sentence restarted by the next one.
  const retakeStarts = new Map<number, number>();
  if (o.retakes) {
    const tokens = words.map((w) => (w.kind === "word" ? norm(w.text) : ""));
    const same = (i: number, j: number, n: number) => {
      for (let k = 0; k < n; k++) if (!tokens[i + k] || tokens[i + k] !== tokens[j + k]) return false;
      return true;
    };
    // One rule: an earlier attempt is a retake only if it is abandoned, i.e. it repeats the restart word for word (a pure
    // restart after a pause, filler or dash) or it is visibly cut off (ends in a dash or ellipsis, or a filler follows it).
    // An attempt that goes on with different words after the shared prefix is a parallel structure and stays.
    const cutOff = (i: number, j: number) =>
      /[-–—…]$|\.\.\.$/.test(words[j - 1].text) || words.slice(i, j).some((w) => w.kind === "filler");
    const decide = (i: number, j: number, n: number): "retake" | "parallel" | "repeat" => {
      let shared = 0;
      while (
        i + shared < j &&
        j + shared < words.length &&
        tokens[i + shared] &&
        tokens[i + shared] === tokens[j + shared]
      )
        shared++;
      const attemptWords = words.slice(i, j).filter((w) => w.kind !== "filler").length;
      const pause = words[j].startSec - words[j - 1].endSec;
      if (cutOff(i, j) && shared >= n) return "retake";
      if (shared >= attemptWords) return pause >= 0.12 ? "retake" : "repeat";
      return "parallel";
    };
    let notedUntil = 0;
    for (let j = 1; j < words.length; j++) {
      const s = sentenceOf[j];
      let found: { i: number; n: number } | undefined;
      let candidate: { i: number; n: number; verdict: "parallel" | "repeat" } | undefined;
      if (sentences[s].first === j && s > 0 && sentences[s - 1].last === j - 1) {
        const p = sentences[s - 1],
          n = Math.min(3, p.last - p.first + 1);
        if (n >= 2 && j + n <= words.length && same(p.first, j, n) && sentences[s].last - j >= p.last - p.first - 1) {
          const verdict = decide(p.first, j, n);
          if (verdict === "retake") found = { i: p.first, n };
          else candidate = { i: p.first, n, verdict };
        }
      }
      for (let n = 4; !found && n >= 2; n--)
        for (let i = j - n; !found && i >= Math.max(sentences[s].first, j - n - o.maxRetakeExtraWords); i--) {
          if (j + n > sentences[s].last + 1 || !same(i, j, n)) continue;
          const verdict = decide(i, j, n);
          if (verdict === "retake") found = { i, n };
          else candidate ??= { i, n, verdict };
        }
      if (!found && candidate && candidate.i >= notedUntil && (notedUntil = j + candidate.n))
        rejected.push({
          kind: "retake",
          atSec: words[candidate.i].startSec,
          words: words
            .slice(candidate.i, j + candidate.n)
            .map((w) => w.text)
            .join(" "),
          reason:
            candidate.verdict === "parallel"
              ? "parallel structure: different words follow the shared opening, so both are kept (deliberate repetition)"
              : "repeated words with no pause, filler or dash before the restart; may be deliberate repetition",
        });
      if (!found) continue;
      const attempt = words.slice(found.i, j);
      if (
        attempt.some((w) => NEGATION.test(norm(w.text)) || CAVEAT.test(norm(w.text)) || ATTRIBUTION.test(norm(w.text)))
      ) {
        rejected.push({
          kind: "retake",
          atSec: words[found.i].startSec,
          words: attempt.map((w) => w.text).join(" "),
          reason: "abandoned take contains a negation, caveat or attribution; review by ear",
        });
        continue;
      }
      if (attempt.some((_, k) => removed.has(found!.i + k) && removalReason.get(found!.i + k)?.kind === "retake"))
        continue;
      for (let k = found.i; k < j; k++) {
        removed.add(k);
        removalReason.set(k, {
          kind: "retake",
          text: attempt.map((w) => w.text).join(" "),
          evidence: [
            `restart repeats "${words
              .slice(j, j + found.n)
              .map((w) => w.text)
              .join(" ")}"`,
          ],
        });
      }
      retakeStarts.set(found.i, j);
    }
  }

  // Protected statements: never cut inside; a restarted sentence is protected from the restart onwards.
  const protectedSpans: RecutPlan["protectedSpans"] = [];
  const protectedWord = new Array<boolean>(words.length).fill(false);
  sentences.forEach((sentence, s) => {
    const all = words.slice(sentence.first, sentence.last + 1).map((w) => norm(w.text));
    const kind = all.some((t) => NEGATION.test(t))
      ? "negation"
      : all.some((t) => CAVEAT.test(t))
        ? "caveat"
        : all.some((t) => ATTRIBUTION.test(t))
          ? "attribution"
          : null;
    const restarts = [...retakeStarts.values()].filter((j) => sentenceOf[j] === s);
    if (!kind && !restarts.length) return;
    let first = sentence.first;
    while (first <= sentence.last && removed.has(first)) first++;
    if (kind)
      for (let r = first; r <= sentence.last; r++)
        if (removed.has(r)) {
          removed.delete(r);
          rejected.push({
            kind: "retake",
            atSec: words[r].startSec,
            words: words[r].text,
            reason: `inside a protected ${kind}; only a whole leading take can be removed`,
          });
        }
    if (!kind) first = Math.max(first, ...restarts);
    if (first > sentence.last) return;
    for (let k = first; k <= sentence.last; k++) protectedWord[k] = true;
    protectedSpans.push({
      startFrame: frames[first].start,
      endFrame: frames[sentence.last].end,
      kind: kind ?? "complete-statement",
      reason: kind ? `${kind} in "${sentence.text.slice(0, 80)}"` : "complete retake kept whole",
      text: words
        .slice(first, sentence.last + 1)
        .map((w) => w.text)
        .join(" "),
    });
  });

  if (o.fillers)
    words.forEach((word, i) => {
      if (word.kind !== "filler" || removed.has(i)) return;
      if (protectedWord[i]) {
        rejected.push({
          kind: "filler",
          atSec: word.startSec,
          words: word.text,
          reason: "inside a protected statement",
        });
        return;
      }
      const neighbours = [words[i - 1], words[i + 1]].filter(Boolean).map((w) => w.speaker);
      if (
        word.speaker !== null &&
        neighbours.length &&
        neighbours.every((speaker) => speaker !== null && speaker !== word.speaker)
      ) {
        rejected.push({
          kind: "filler",
          atSec: word.startSec,
          words: word.text,
          reason: "backchannel from another speaker; not part of this speaker's line",
        });
        return;
      }
      removed.add(i);
      removalReason.set(i, { kind: "filler", text: word.text, evidence: [] });
    });

  // A removal (filler or abandoned take) is speech, so a VAD mask cannot vouch for its edges. Its cut points are the
  // quietest frame boundaries in the neighbouring gaps, reaching up to 60ms inside the removed words' ASR edges,
  // judged by level against the same bar for fillers and retakes; the v3 join then snaps within those regions.
  const adjusted = new Map<number, { start: number; end: number }>();
  const quiet = (frame: number) => {
    const t = secAt(frame);
    let best = Infinity;
    for (let d = -0.01; d <= 0.01 + 1e-9; d += 0.005) best = Math.min(best, levelDb!(t + d - 0.005, t + d + 0.005));
    return best;
  };
  const removalCut = (
    a: number,
    r0: number,
    r1: number,
    b: number,
  ): { startFrame: number; endFrame: number; first: number; last: number; note: string } | { reason: string } => {
    const aEnd = frames[a].end,
      bStart = frames[b].start;
    const preferredStart = aEnd + Math.min(Math.ceil((frames[r0].start - aEnd) / 2), Math.round(ms(o.postPadMs) * 30));
    const preferredEnd = bStart - Math.min(Math.ceil((bStart - frames[r1].end) / 2), Math.round(ms(o.prePadMs) * 30));
    // Normalised sources round keeps outward to 30fps master frames; the removed words must start after that rounding.
    const edges = (startFrame: number, endFrame: number) => {
      const outStart = source.boundaries ? frameAt(Math.ceil(secAt(startFrame) * 30 - 1e-9) / 30, "ceil") : startFrame;
      const outEnd = source.boundaries ? frameAt(Math.floor(secAt(endFrame) * 30 + 1e-9) / 30, "floor") : endFrame;
      const first = Math.max(frames[r0].start, outStart),
        last = Math.min(frames[r1].end, outEnd);
      return { first, last, ok: first < frames[r0].end && last > frames[r1].start && first < last };
    };
    const handles = (startFrame: number, endFrame: number) => {
      const { first, last, ok } = edges(startFrame, endFrame);
      return ok ? Math.min(startFrame - aEnd, endFrame - last) + Math.min(first - startFrame, bStart - endFrame) : 0;
    };
    if (!levelDb || cleanDb === null) {
      const gapBefore = words[r0].startSec - words[a].endSec,
        gapAfter = words[b].startSec - words[r1].endSec;
      if (gapBefore < ms(o.fillerMinGapMs) || gapAfter < ms(o.fillerMinGapMs))
        return {
          reason: `touches a neighbouring word with no audio levels to judge (gaps ${Math.round(gapBefore * 1000)}/${Math.round(gapAfter * 1000)}ms)`,
        };
      if (frames[r0].start - aEnd < 1 || bStart - frames[r1].end < 1 || handles(preferredStart, preferredEnd) < 1)
        return { reason: "less than one frame of silence on a side for a clean join" };
      return {
        startFrame: preferredStart,
        endFrame: preferredEnd,
        first: frames[r0].start,
        last: frames[r1].end,
        note: "transcript gaps only",
      };
    }
    const inside = (i: number) => Math.min(0.06, (words[i].endSec - words[i].startSec) / 2);
    const lastStart = Math.min(frameAt(words[r0].startSec + inside(r0), "floor"), frames[r1].end - 1);
    const firstEnd = Math.max(frameAt(words[r1].endSec - inside(r1), "ceil"), frames[r0].start + 1);
    let best: { startFrame: number; endFrame: number; db: number; room: number; drift: number } | null = null;
    for (let startFrame = aEnd; startFrame <= lastStart; startFrame++)
      for (let endFrame = Math.max(firstEnd, startFrame + 1); endFrame <= bStart; endFrame++) {
        const room = handles(startFrame, endFrame);
        if (room < 1) continue;
        const db = Math.max(quiet(startFrame), quiet(endFrame)),
          drift = Math.abs(startFrame - preferredStart) + Math.abs(endFrame - preferredEnd);
        if (
          !best ||
          db < best.db - 1 ||
          (Math.abs(db - best.db) <= 1 && (room > best.room || (room === best.room && drift < best.drift)))
        )
          best = { startFrame, endFrame, db, room, drift };
      }
    if (!best) return { reason: "no frame boundary leaves room for a crossfade at the join" };
    const { first, last } = edges(best.startFrame, best.endFrame);
    const note = `${quiet(best.startFrame).toFixed(0)} / ${quiet(best.endFrame).toFixed(0)} dBFS (bar ${cleanDb.toFixed(0)} dBFS: speech ${speechDb!.toFixed(0)}, floor ${floorDb === null ? "unknown" : floorDb.toFixed(0)})`;
    return best.db <= cleanDb
      ? { startFrame: best.startFrame, endFrame: best.endFrame, first, last, note }
      : { reason: `cut points not quiet enough: ${note}` };
  };

  // Gaps between kept words become cuts: removals keep natural padding where it is quiet, long pauses shorten.
  const cuts: Omit<RecutCandidate, "id">[] = [];
  const kept = () => words.map((_, i) => i).filter((i) => !removed.has(i));
  for (let pass = 0; pass < 4; pass++) {
    cuts.length = 0;
    adjusted.clear();
    const keep = kept();
    let failed = false;
    if (!keep.length) throw new Error("Every word would be removed");
    const first = keep[0],
      lastWord = keep.at(-1)!;
    const head = frameAt(Math.max(0, words[first].startSec - ms(o.prePadMs)), "floor");
    const edge = (inner: number[], startFrame: number, endFrame: number, kind: "head" | "tail") => {
      const kinds = new Set(inner.map((i) => removalReason.get(i)?.kind)),
        kindName = kinds.has("retake") ? "retake" : "filler";
      const point = pointEvidence(secAt(kind === "head" ? endFrame : startFrame), false);
      if (endFrame - startFrame < 1 || !point.clean) {
        for (const i of inner) {
          removed.delete(i);
          rejected.push({
            kind: kindName,
            atSec: words[i].startSec,
            words: words[i].text,
            reason: `no clean silence between the removal and the kept speech (${point.note})`,
          });
        }
        failed = true;
        return;
      }
      cuts.push({
        kind: kindName,
        startSec: secAt(startFrame),
        endSec: secAt(endFrame),
        startFrame,
        endFrame,
        removedWordIds: inner.map((i) => words[i].id),
        reason: `${kindName === "retake" ? "false start or repeated take" : "filler"} "${inner.map((i) => words[i].text).join(" ")}" at the ${kind === "head" ? "start" : "end"}`,
        evidence: [`cut point: ${point.note}`, ...new Set(inner.flatMap((i) => removalReason.get(i)?.evidence ?? []))],
        ...context(inner[0], inner.at(-1)! + 1),
      });
    };
    const leadingRemoved = words.map((_, i) => i).filter((i) => i < first);
    if (leadingRemoved.length)
      edge(
        leadingRemoved,
        0,
        Math.max(frames[leadingRemoved.at(-1)!].end, Math.min(head, frames[first].start - 1)),
        "head",
      );
    else if (head >= 2 && !speechIn(0, secAt(head)))
      cuts.push({
        kind: "head",
        startSec: 0,
        endSec: secAt(head),
        startFrame: 0,
        endFrame: head,
        removedWordIds: [],
        reason: `leading silence trimmed to ${o.prePadMs}ms`,
        evidence: [mask ? "VAD silent" : "no words"],
        ...context(0, 0),
      });
    for (let k = 0; k + 1 <= keep.length; k++) {
      const a = keep[k],
        b = keep[k + 1];
      if (b === undefined) break;
      const inner = words.map((_, i) => i).filter((i) => i > a && i < b);
      const gap = words[b].startSec - words[a].endSec;
      const sentenceEnd = /[.!?…]["»”)]*$/.test(words[a].text) || words[a].speaker !== words[b].speaker;
      if (inner.length) {
        const r0 = inner[0],
          r1 = inner.at(-1)!,
          kinds = new Set(inner.map((i) => removalReason.get(i)?.kind));
        const kindName = kinds.has("retake") ? "retake" : "filler";
        const gapBefore = words[r0].startSec - words[a].endSec,
          gapAfter = words[b].startSec - words[r1].endSec;
        const choice = removalCut(a, r0, r1, b);
        const why = protectedWord.slice(a, b + 1).some((p, x) => p && inner.includes(a + x))
          ? "inside a protected statement"
          : "reason" in choice
            ? choice.reason
            : null;
        if (why || "reason" in choice) {
          for (const i of inner) {
            removed.delete(i);
            rejected.push({ kind: kindName, atSec: words[i].startSec, words: words[i].text, reason: why! });
          }
          failed = true;
          continue;
        }
        const { startFrame, endFrame } = choice;
        adjusted.set(r0, { start: choice.first, end: r0 === r1 ? choice.last : frames[r0].end });
        if (r1 !== r0) adjusted.set(r1, { start: frames[r1].start, end: choice.last });
        cuts.push({
          kind: kindName,
          startSec: secAt(startFrame),
          endSec: secAt(endFrame),
          startFrame,
          endFrame,
          removedWordIds: inner.map((i) => words[i].id),
          reason:
            kindName === "retake"
              ? `false start or repeated take "${words
                  .slice(r0, r1 + 1)
                  .map((w) => w.text)
                  .join(" ")}"; the later complete take stays`
              : `filler "${words
                  .slice(r0, r1 + 1)
                  .map((w) => w.text)
                  .join(" ")}"`,
          evidence: [
            `transcript gaps ${Math.round(gapBefore * 1000)}ms before, ${Math.round(gapAfter * 1000)}ms after`,
            `cut points: ${choice.note}`,
            ...new Set(inner.flatMap((i) => removalReason.get(i)?.evidence ?? [])),
          ],
          ...context(r0, r1 + 1),
        });
        continue;
      }
      if (gap * 1000 <= o.longPauseMs) continue;
      const target = ms(sentenceEnd ? o.sentencePauseMs : o.midPauseMs);
      const lead = (target * o.postPadMs) / (o.postPadMs + o.prePadMs);
      const startFrame = frameAt(words[a].endSec + lead, "ceil"),
        endFrame = frameAt(words[b].startSec - (target - lead), "floor");
      if (endFrame - startFrame < 2 || startFrame < frames[a].end || endFrame > frames[b].start) continue;
      if (protectedWord[a] && protectedWord[b] && sentenceOf[a] === sentenceOf[b]) {
        rejected.push({
          kind: "pause",
          atSec: words[a].endSec,
          words: `${words[a].text} … ${words[b].text}`,
          reason: "pause inside a protected statement kept whole",
        });
        continue;
      }
      if (speechIn(secAt(startFrame), secAt(endFrame))) {
        rejected.push({
          kind: "pause",
          atSec: words[a].endSec,
          words: `${words[a].text} … ${words[b].text}`,
          reason: "VAD hears speech in the pause (untranscribed sound); left for review",
        });
        continue;
      }
      cuts.push({
        kind: "pause",
        startSec: secAt(startFrame),
        endSec: secAt(endFrame),
        startFrame,
        endFrame,
        removedWordIds: [],
        reason: `pause ${gap.toFixed(2)}s shortened to ${target.toFixed(2)}s (${sentenceEnd ? "sentence end" : "mid-clause"})`,
        evidence: [mask ? "VAD silent across the cut" : "no transcript words in the gap"],
        ...context(b, b),
      });
    }
    const tail = frameAt(Math.min(duration, words[lastWord].endSec + ms(o.postPadMs)), "ceil");
    const trailingRemoved = words.map((_, i) => i).filter((i) => i > lastWord);
    if (trailingRemoved.length)
      edge(
        trailingRemoved,
        Math.min(frames[trailingRemoved[0]].start, Math.max(tail, frames[lastWord].end + 1)),
        source.frameCount,
        "tail",
      );
    else if (source.frameCount - tail >= 2 && !speechIn(secAt(tail), duration))
      cuts.push({
        kind: "tail",
        startSec: secAt(tail),
        endSec: duration,
        startFrame: tail,
        endFrame: source.frameCount,
        removedWordIds: [],
        reason: `trailing silence trimmed to ${o.postPadMs}ms`,
        evidence: [mask ? "VAD silent" : "no words"],
        ...context(words.length, words.length),
      });
    if (!failed) break;
  }
  const numbered = cuts.sort((x, y) => x.startFrame - y.startFrame).map((cut, i) => ({ id: `C${i + 1}`, ...cut }));
  const rejectedIds = new Set(o.reject.map((id) => id.toUpperCase()));
  for (const id of rejectedIds)
    if (!numbered.some((c) => c.id === id)) throw new Error(`Unknown cut id to reject: ${id}`);
  let accepted = numbered.filter((c) => !rejectedIds.has(c.id));
  for (const cut of numbered)
    if (rejectedIds.has(cut.id))
      rejected.push({
        kind: cut.kind,
        atSec: cut.startSec,
        words: cut.removed || cut.reason,
        reason: `rejected by reviewer (${cut.id})`,
      });
  const keepCount = () =>
    accepted.length +
    1 -
    (accepted[0]?.startFrame === 0 ? 1 : 0) -
    (accepted.at(-1)?.endFrame === source.frameCount ? 1 : 0);
  while (keepCount() > 200) {
    const bySize = (kind: RecutCandidate["kind"]) =>
      accepted.filter((c) => c.kind === kind).sort((x, y) => x.endFrame - x.startFrame - (y.endFrame - y.startFrame));
    const pauses = bySize("pause").length ? bySize("pause") : bySize("filler");
    if (!pauses.length) throw new Error("More than 200 kept spans are needed for retakes alone; split the recording");
    accepted = accepted.filter((c) => c !== pauses[0]);
    rejected.push({
      kind: pauses[0].kind,
      atSec: pauses[0].startSec,
      words: pauses[0].reason,
      reason: `deferred (${pauses[0].id}): a request holds at most 200 kept spans; split the recording to keep it`,
    });
  }
  const restored = accepted.flatMap((c) => c.removedWordIds);
  for (const i of [...removed]) if (!restored.includes(words[i].id)) removed.delete(i);
  for (const i of [...adjusted.keys()]) if (!restored.includes(words[i].id)) adjusted.delete(i);

  const keepSpans: RecordingEditRequest["keepSpans"] = [];
  let cursor = 0;
  const textBetween = (from: number, to: number) => {
    const inside = words
      .filter((_, i) => frames[i].start >= from && frames[i].end <= to && !removed.has(i))
      .map((w) => w.text);
    const text =
      inside.length > 8 ? `${inside.slice(0, 4).join(" ")} … ${inside.slice(-4).join(" ")}` : inside.join(" ");
    return text ? `speech: ${text}` : "silence kept as padding";
  };
  for (const cut of [...accepted, { startFrame: source.frameCount, endFrame: source.frameCount }]) {
    if (cut.startFrame > cursor)
      keepSpans.push({
        id: `k${keepSpans.length + 1}`,
        startFrame: cursor,
        endFrame: cut.startFrame,
        reason: textBetween(cursor, cut.startFrame),
      });
    cursor = cut.endFrame;
  }
  const quietest = (): { startFrame: number; endFrame: number } | null => {
    if (o.roomToneSpan) {
      // A chosen span passes the same tests as the automatic one: at least 300 ms, inside the recording, no speech, no word.
      const { startSec, endSec } = o.roomToneSpan;
      const startFrame = frameAt(startSec, "ceil"),
        endFrame = frameAt(endSec, "floor");
      const problem =
        !(Number.isFinite(startSec) && Number.isFinite(endSec)) || startSec < 0 || endSec > duration + 1e-6
          ? `must lie inside the recording (0–${duration.toFixed(2)} s)`
          : endSec - startSec < 0.3 || endFrame - startFrame < 3
            ? "must be at least 300 ms"
            : speechIn(startSec, endSec)
              ? "overlaps detected speech"
              : frames.some((f) => f.start < endFrame && f.end > startFrame)
                ? "overlaps a transcript word"
                : undefined;
      if (problem) throw new Error(`Room tone span ${startSec}–${endSec} s ${problem}; choose another or omit it`);
      return { startFrame, endFrame };
    }
    if (!o.roomTone) return null;
    let best: { startFrame: number; endFrame: number; db: number } | null = null;
    for (let i = -1; i < words.length; i++) {
      const from = (i < 0 ? 0 : words[i].endSec) + 0.05,
        to = (words[i + 1]?.startSec ?? duration) - 0.05;
      for (let t = from; t + 0.3 <= to; t += 0.1) {
        const startFrame = frameAt(t, "ceil"),
          endFrame = frameAt(t + 0.3, "floor");
        if (
          endFrame - startFrame < 3 ||
          speechIn(t, t + 0.3) ||
          frames.some((f) => f.start < endFrame && f.end > startFrame)
        )
          continue;
        const db = levelDb ? levelDb(t, t + 0.3) : -(to - from);
        if (!best || db < best.db) best = { startFrame, endFrame, db };
      }
    }
    if (!best) throw new Error("No silent span of 300ms for room tone; omit --room-tone");
    return { startFrame: best.startFrame, endFrame: best.endFrame };
  };
  const tone = quietest();
  const request = {
    version: 3 as const,
    workflow: "recording-edit" as const,
    projectId: input.projectId,
    name: input.name,
    profile: "recording-only" as const,
    formats: input.formats,
    source: source.boundaries
      ? {
          file: source.file,
          sha256: source.sha256,
          version: source.version,
          fps: source.fps,
          normalization: {
            targetFps: { num: 30 as const, den: 1 as const },
            video: "timestamp-near" as const,
            keepRounding: "outward" as const,
            boundaryRounding: "nearest" as const,
            audio: "preserve-clock" as const,
          },
        }
      : {
          file: source.file,
          sha256: source.sha256,
          version: source.version,
          fps: { num: 30 as const, den: 1 as const },
        },
    transcript: {
      version: `${transcript.engine.provider}:${transcript.engine.model}:${createHash("sha256").update(JSON.stringify(transcript.words)).digest("hex").slice(0, 16)}`,
      language: transcript.language,
      words: words.map((w: TranscriptWord, i) => ({
        id: w.id,
        text: w.text,
        startFrame: (adjusted.get(i) ?? frames[i]).start,
        endFrame: (adjusted.get(i) ?? frames[i]).end,
        ...(w.speaker ? { speaker: w.speaker } : {}),
      })),
    },
    keepSpans,
    cuts: accepted.map((c) => ({ startFrame: c.startFrame, endFrame: c.endFrame, reason: `${c.id}: ${c.reason}` })),
    protectedSpans: protectedSpans.map(({ text: _text, ...span }) => span),
    revision: 1,
    joins: {
      crossfadeMs: o.crossfadeMs,
      curve: "equal-power" as const,
      snap: { energyWindowMs: 10 as const, searchMs: o.snapSearchMs, zeroCrossingMs: 5 as const },
      roomTone: tone ? { ...tone, gainDb: o.roomToneGainDb } : null,
      punchIn: o.punchIn ? { scale: o.punchIn, pattern: "alternate" as const } : null,
    },
  };
  const removedSec = accepted.reduce((n, c) => n + c.endSec - c.startSec, 0);
  return {
    request,
    cuts: accepted,
    rejected: [...new Map(rejected.map((r) => [JSON.stringify(r), r])).values()].sort((x, y) => x.atSec - y.atSec),
    protectedSpans,
    summary: {
      sourceSec: duration,
      outputSec: duration - removedSec,
      removedSec,
      fillers: accepted.filter((c) => c.kind === "filler").length,
      retakes: accepted.filter((c) => c.kind === "retake").length,
      pauses: accepted.filter((c) => c.kind === "pause").length,
      maskUsed: !!mask,
      levelsUsed: cleanDb !== null,
    },
  };
}

const LIKELY_FILLER = new Set(["ну", "э", "ээ", "эм", "вот", "um", "uh", "er", "erm", "hmm"]);
const STANDALONE_GAP_SEC = 0.15;

/**
 * For a transcript that is not verbatim (`speech:local`): standalone "ну", "э", "вот", "um", "uh"... that the engine
 * did not mark as fillers, with a pause of 150 ms or punctuation on both sides (or a speaker change, or the edge).
 * Information for the reviewer only: never a cut, never part of the request or its hash.
 */
export function likelyUnmarkedFillers(transcript: Transcript): { atSec: number; text: string; context: string }[] {
  if (transcript.engine.verbatim) return [];
  const words = transcript.words.filter((w) => w.kind === "word");
  const breakAfter = (w: TranscriptWord) => /[,.!?…;:—–-]["»”')\]]*$/u.test(w.text.trim());
  return words.flatMap((w, i) => {
    if (!LIKELY_FILLER.has(norm(w.text))) return [];
    const prev = words[i - 1],
      next = words[i + 1];
    const before =
      !prev || prev.speaker !== w.speaker || breakAfter(prev) || w.startSec - prev.endSec >= STANDALONE_GAP_SEC;
    const after =
      !next || next.speaker !== w.speaker || breakAfter(w) || next.startSec - w.endSec >= STANDALONE_GAP_SEC;
    if (!before || !after) return [];
    return [
      {
        atSec: w.startSec,
        text: w.text,
        context: words
          .slice(Math.max(0, i - 4), i + 5)
          .map((x) => x.text)
          .join(" "),
      },
    ];
  });
}

export function renderRecutMarkdown(
  plan: RecutPlan,
  extra: {
    transcriptFile: string;
    requestFile: string;
    editHash?: string;
    unmarkedFillers?: { atSec: number; text: string; context: string }[];
    joins?: {
      outputFrame: number;
      offsetSamples: number;
      crossfadeSamples: number;
      zeroCrossing: boolean;
      centreEnergyDbfs: number;
    }[];
  },
): string {
  const s = plan.summary;
  const lines = [
    `# Recut plan: ${plan.request.name}`,
    "",
    `Proposal only. Nothing is approved until a person watches the whole source and the cuts below, then adds \`review.approvedEditHash\` to \`${extra.requestFile}\`.`,
    "",
    `- Transcript: \`${extra.transcriptFile}\` (${plan.request.transcript.language}); source \`${plan.request.source.file}\``,
    `- Duration: ${s.sourceSec.toFixed(2)}s → ${s.outputSec.toFixed(2)}s (${s.removedSec.toFixed(2)}s removed)`,
    `- Cuts: ${plan.cuts.length} (${s.fillers} filler, ${s.retakes} retake, ${s.pauses} pause, plus head/tail trims)`,
    `- Evidence used: transcript${s.maskUsed ? ", VAD speech mask" : ""}${s.levelsUsed ? ", audio levels" : ""}`,
    ...(extra.editHash ? [`- Edit hash to approve: \`${extra.editHash}\``] : []),
    "",
    "To reject a cut, run `pnpm recut:plan` again with `--reject C3,C7` (ids stay stable). Reordering, speed changes and new words are never proposed.",
    "",
    "## Proposed cuts",
    "",
  ];
  for (const cut of plan.cuts) {
    const body =
      cut.kind === "pause"
        ? `…${cut.before} [pause shortened] ${cut.after}…`
        : cut.kind === "head"
          ? `[leading silence] ${cut.after}…`
          : cut.kind === "tail"
            ? `…${cut.before} [trailing silence]`
            : `…${cut.before} ~~${cut.removed}~~ ${cut.after}…`;
    lines.push(
      `- [ ] **${cut.id}** ${cut.kind} · ${clock(cut.startSec)}–${clock(cut.endSec)} (frames ${cut.startFrame}–${cut.endFrame}, ${(cut.endSec - cut.startSec).toFixed(2)}s)`,
      `  - ${body.replace(/\s+/g, " ")}`,
      `  - ${cut.reason}`,
      `  - Evidence: ${cut.evidence.join("; ")}`,
    );
  }
  if (!plan.cuts.length) lines.push("No cuts proposed.");
  lines.push("", "## Protected statements (never cut inside)", "");
  for (const span of plan.protectedSpans)
    lines.push(`- ${span.kind} · frames ${span.startFrame}–${span.endFrame}: "${span.text}"`);
  if (!plan.protectedSpans.length)
    lines.push("None detected. Statements without a marker still need a human read for meaning.");
  if (extra.unmarkedFillers?.length) {
    lines.push(
      "",
      "## Likely fillers the transcript did not mark (information only)",
      "",
      'The transcript is not verbatim, so these standalone words were not marked as fillers and are not proposed as cuts. Listen to them; a verbatim Scribe transcript marks fillers. "Вот" and "ну" are often meant: cut none of them without listening.',
      "",
    );
    for (const f of extra.unmarkedFillers) lines.push(`- ${clock(f.atSec)} "${f.text}": …${f.context}…`);
  }
  lines.push("", "## Considered and not proposed", "");
  for (const r of plan.rejected) lines.push(`- ${r.kind} at ${clock(r.atSec)} "${r.words}": ${r.reason}`);
  if (!plan.rejected.length) lines.push("None.");
  const j = plan.request.joins;
  lines.push(
    "",
    "## Joins",
    "",
    `Equal-power crossfade ${j.crossfadeMs}ms, snapped to the quietest 10ms window within ±${j.snap.searchMs}ms and then to a zero crossing within 5ms. Room tone: ${j.roomTone ? `frames ${j.roomTone.startFrame}–${j.roomTone.endFrame} at ${j.roomTone.gainDb} dB` : "off"}. Punch-in: ${j.punchIn ? `${j.punchIn.scale}× on alternate spans` : "off"}.`,
    "",
  );
  for (const join of extra.joins ?? [])
    lines.push(
      `- output frame ${join.outputFrame}: centre ${(join.offsetSamples / 48).toFixed(1)}ms from the picture cut, ${(join.crossfadeSamples / 48).toFixed(1)}ms fade, ${join.centreEnergyDbfs} dBFS${join.zeroCrossing ? ", zero crossing" : ""}`,
    );
  return lines.join("\n") + "\n";
}
