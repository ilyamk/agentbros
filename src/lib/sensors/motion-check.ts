import { CliErrorObject, emitProgress } from "../cli";
import { withComposition, type CompositionSource } from "../vision/composition";
import {
  applyAllow,
  formatTable,
  mergeOccurrences,
  selectFrames,
  splitIntended,
  tally,
  type AllowRule,
  type CounterName,
  type Occurrence,
} from "./findings";
import { withFramePage, type FramePage, type PageEvents } from "./page";
import { cellsFromRgb, FlashTracker, flashOccurrences, measureFlashesInFile } from "./flash";
import {
  checkDeadFrames,
  checkFadedFinal,
  comparePixels,
  decodePng,
  differsVisibly,
  FADE_LOOKBACK_FRAMES,
  measurePixels,
  type FramePixels,
} from "./pixels";
import { checkRender, probeRender } from "./render-file";
import { slopFilmOccurrences, slopFrameOccurrences, type SampledText } from "./slop-signatures";
import {
  checkText,
  dropTransits,
  fallbackOccurrence,
  fallbackRuns,
  recordPositions,
  type PlatformFont,
  type SafeZone,
  type TextPositions,
} from "./text-checks";

const MAX_FINDINGS = 40;
const MAX_FAILED_FRAMES = 3;
const DETERMINISM_SAMPLES = 3;

export type MotionCheckOptions = {
  source: CompositionSource;
  frames?: string;
  safeZone?: SafeZone & { name: string };
  allow: AllowRule[];
  loopFrames?: number;
  render?: string;
  codec?: string;
};

/** One short line, without the bundle server's port, which changes per page and would split one error into several findings. */
const clean = (message: string) =>
  message
    .split("\n")
    .slice(0, 3)
    .join(" ")
    .replace(/http:\/\/localhost:\d+/g, "")
    .slice(0, 400);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Spread across the checked frames, skipping the first because the page opens on it. */
export function determinismSample(frames: number[]): number[] {
  const later = frames.slice(1);
  if (later.length <= DETERMINISM_SAMPLES) return later;
  return [
    ...new Set(
      Array.from(
        { length: DETERMINISM_SAMPLES },
        (_, index) => later[Math.round(((index + 1) * (later.length - 1)) / DETERMINISM_SAMPLES)]!,
      ),
    ),
  ];
}

export type DeterminismVerdict = { verdict: "same" | "flaky" | "differs"; first: string; retry?: string };

/**
 * Compares a frame reached in sequence with the same frame opened directly. A first mismatch is captured once more on
 * both sides (a fresh direct open and a fresh seek from the previous frame), because a capture under heavy load can
 * read a raster that has not finished. Only a mismatch that persists is "differs"; one that clears is "flaky".
 */
export async function compareDeterminism(
  sequential: Buffer,
  captureDirect: () => Promise<Buffer>,
  captureSequential: () => Promise<Buffer>,
  width: number,
): Promise<DeterminismVerdict> {
  const direct = await captureDirect();
  if (!differsVisibly(sequential, direct)) return { verdict: "same", first: "" };
  const first = comparePixels(sequential, direct, width);
  const directAgain = await captureDirect();
  const sequentialAgain = await captureSequential();
  if (!differsVisibly(sequentialAgain, directAgain)) return { verdict: "flaky", first };
  return { verdict: "differs", first, retry: comparePixels(sequentialAgain, directAgain, width) };
}

export async function runMotionCheck(options: MotionCheckOptions) {
  return withComposition(options.source, async (session) => {
    const { composition } = session;
    const { durationInFrames, width, height, id, fps } = composition;
    const last = durationInFrames - 1;
    const { loopFrames, safeZone, render } = options;
    if (loopFrames !== undefined && (!Number.isInteger(loopFrames) || loopFrames < 1 || loopFrames > last))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--loop-frames must be a whole frame between 1 and ${last}: frame N has to exist to compare it with frame 0. Register the composition one frame longer if the loop is as long as the video.`,
      });

    const selected = selectFrames(options.frames, durationInFrames);
    const hasFinal = selected.includes(last) && last >= FADE_LOOKBACK_FRAMES;
    const frames = [
      ...new Set([
        ...selected,
        ...(hasFinal ? [last - FADE_LOOKBACK_FRAMES] : []),
        ...(loopFrames ? [0, loopFrames] : []),
      ]),
    ].sort((a, b) => a - b);
    const sample = determinismSample(frames);
    const keepRaw = new Set([...sample, ...(loopFrames ? [0, loopFrames] : [])]);

    const skipped: Partial<Record<CounterName, string>> = {};
    if (!safeZone) skipped.textOutsideSafeZone = "pass --safe-zone";
    if (loopFrames === undefined) skipped.loopSeam = "pass --loop-frames";
    if (!render) skipped.renderFile = "pass --render";
    if (!hasFinal)
      skipped.fadedFinal = selected.includes(last)
        ? `the composition has under ${FADE_LOOKBACK_FRAMES + 1} frames`
        : "--frames does not include the last frame";
    if (!sample.length) skipped.nonDeterministic = "needs at least two frames";
    /** Flashes need every frame: the encoded file when there is one, else a consecutive --frames range. */
    const flashFromCaptures =
      !render &&
      selected.length > 1 &&
      selected.every((frame, index) => index === 0 || frame === selected[index - 1]! + 1);
    if (!render && !flashFromCaptures)
      skipped.flashRisk = "needs every frame: pass --render, or a consecutive --frames a-b";
    const flashCells = new Map<number, Float32Array>();

    const occurrences: Occurrence[] = [];
    const positions: TextPositions = new Map();
    const pixels = new Map<number, FramePixels>();
    const raws = new Map<number, Buffer>();
    const usedFonts = new Map<string, PlatformFont[]>();
    const sampledTexts: SampledText[] = [];
    let currentFrame = frames[0]!;
    let textNodes = 0;
    const events: PageEvents = {
      onException: (message) =>
        occurrences.push({
          code: "RUNTIME_ERROR",
          frame: currentFrame,
          key: clean(message),
          message: `Uncaught exception at frame ${currentFrame}: ${clean(message)}`,
          fix: "Fix the exception at the top of this stack; the composition must render every frame without throwing.",
        }),
      onConsoleError: (message) =>
        occurrences.push({
          code: "CONSOLE_ERROR",
          frame: currentFrame,
          key: clean(message),
          message: `console.error at frame ${currentFrame}: ${clean(message)}`,
          fix: "Fix its cause: a missing asset, an invalid prop or an unhandled state. Rendering carries on past these, so they ship silently.",
        }),
    };

    const readFrame = async (page: FramePage, frame: number) => {
      const measurement = await page.measure();
      textNodes += measurement.texts.length;
      recordPositions(positions, frame, measurement.texts);
      if (selected.includes(frame)) sampledTexts.push({ frame, texts: measurement.texts });
      occurrences.push(...slopFrameOccurrences(frame, measurement));
      occurrences.push(...checkText(frame, measurement.texts, { width, height }, safeZone));
      if (!("fallbackFonts" in skipped))
        for (const item of measurement.texts) {
          const key = [item.text, item.family, item.weight, item.style].join("\0");
          try {
            const used = usedFonts.get(key) ?? (await page.platformFonts(item.index));
            usedFonts.set(key, used);
            const runs = fallbackRuns(item.family, used, measurement.customFamilies);
            if (runs.length) occurrences.push(fallbackOccurrence(frame, item, runs));
          } catch (error) {
            skipped.fallbackFonts = `CSS.getPlatformFontsForNode is unavailable: ${clean(errorText(error))}`;
            break;
          }
        }
      const raw = decodePng(await page.capture(), width, height);
      pixels.set(frame, measurePixels(frame, raw));
      if (flashFromCaptures && selected.includes(frame)) flashCells.set(frame, cellsFromRgb(raw, width, height));
      if (keepRaw.has(frame)) raws.set(frame, raw);
    };

    const walk = async () => {
      let next = 0;
      let failures = 0;
      const fail = (frame: number, message: string) => {
        failures++;
        occurrences.push({
          code: "RUNTIME_ERROR",
          frame,
          key: clean(message),
          message: `Frame ${frame} could not render: ${clean(message)}`,
          fix: "Fix this error first; the other counters cannot see a frame that does not render.",
        });
      };
      while (next < frames.length && failures < MAX_FAILED_FRAMES) {
        const opening = frames[next]!;
        currentFrame = opening;
        emitProgress(`Opening frame ${opening}`);
        const failed = await withFramePage(session, opening, events, async (page) => {
          for (; next < frames.length; next++) {
            const frame = frames[next]!;
            currentFrame = frame;
            const thrown = page.exceptions;
            if (frame !== opening)
              try {
                await page.seek(frame);
              } catch (error) {
                if (page.exceptions === thrown) fail(frame, errorText(error));
                else failures++;
                next++;
                return;
              }
            if (page.exceptions > thrown) {
              failures++;
              next++;
              return;
            }
            await readFrame(page, frame);
          }
        });
        if (failed) {
          if (occurrences.some((item) => item.code === "RUNTIME_ERROR" && item.frame === opening)) failures++;
          else fail(opening, failed);
          next++;
        }
      }
      return next >= frames.length;
    };

    const startedAt = Date.now();
    const finished = await walk();
    const walkMs = Date.now() - startedAt;

    if (!pixels.size) {
      const reason = "no frame rendered";
      Object.assign(skipped, {
        textOffStage: reason,
        textOutsideRegion: reason,
        textOverlap: reason,
        fallbackFonts: reason,
        deadFrames: reason,
        simultaneousEntry: reason,
        textCentredAlways: reason,
        emojiText: reason,
        slopPalette: reason,
        ...(safeZone ? { textOutsideSafeZone: reason } : {}),
      });
    }
    occurrences.push(...checkDeadFrames([...pixels.values()], last));
    occurrences.push(
      ...slopFilmOccurrences(
        sampledTexts.sort((a, b) => a.frame - b.frame),
        { width },
      ),
    );
    const final = pixels.get(last);
    const beforeFinal = pixels.get(last - FADE_LOOKBACK_FRAMES);
    if (hasFinal && final && beforeFinal) occurrences.push(...checkFadedFinal(final, beforeFinal));
    else if (hasFinal) skipped.fadedFinal = "the last frames did not render";

    if (loopFrames !== undefined) {
      const first = pixels.get(0);
      const seam = pixels.get(loopFrames);
      if (!first || !seam) skipped.loopSeam = "frame 0 or the seam frame did not render";
      else if (first.hash !== seam.hash)
        occurrences.push({
          code: "LOOP_SEAM",
          frame: loopFrames,
          key: "seam",
          message: `Frame 0 and frame ${loopFrames} differ: ${comparePixels(raws.get(0)!, raws.get(loopFrames)!, width)}.`,
          fix: `Something in that area is not periodic. Make every animated value a function of frame % ${loopFrames}, with whole cycles per loop, and end easings where they start.`,
        });
    }

    const determinismChecked: number[] = [];
    /** Mismatches that were captured again: `cleared` ones were a flaky capture and are not findings. */
    const determinismRetried: { frame: number; cleared: boolean; first: string; retry?: string }[] = [];
    const notDeterministic = (frame: number, message: string): void => {
      occurrences.push({
        code: "NON_DETERMINISTIC",
        frame,
        key: "determinism",
        message,
        fix: "Parallel rendering will flicker here. Derive that area from useCurrentFrame() alone: replace Math.random() with random(seed), remove Date.now() and performance.now(), and do not accumulate state across frames in useState, useRef or module variables.",
      });
    };
    if (!finished) skipped.nonDeterministic = "the walk stopped early";
    else
      for (const frame of sample.filter((item) => pixels.has(item))) {
        currentFrame = frame;
        emitProgress(`Reopening frame ${frame} directly to compare`);
        const previous = frames[frames.indexOf(frame) - 1] ?? frame;
        const capture = async (opening: number): Promise<Buffer> => {
          let raw: Buffer | undefined;
          const failed = await withFramePage(session, opening, events, async (page) => {
            if (opening !== frame) await page.seek(frame);
            raw = decodePng(await page.capture(), width, height);
          });
          if (!raw)
            throw new Error(
              opening === frame
                ? `not when opened directly: ${clean(failed ?? "the page threw")}`
                : `not when reached again from frame ${opening}: ${clean(failed ?? "the page threw")}`,
            );
          return raw;
        };
        try {
          const result = await compareDeterminism(
            raws.get(frame)!,
            () => capture(frame),
            () => capture(previous),
            width,
          );
          determinismChecked.push(frame);
          if (result.verdict !== "same")
            determinismRetried.push({
              frame,
              cleared: result.verdict === "flaky",
              first: result.first,
              ...(result.retry ? { retry: result.retry } : {}),
            });
          if (result.verdict === "differs")
            notDeterministic(
              frame,
              `Frame ${frame} opened directly differs from the same frame reached after earlier frames, and still differs when both are captured again: ${result.retry} (first capture: ${result.first}).`,
            );
        } catch (error) {
          notDeterministic(frame, `Frame ${frame} renders when reached after earlier frames but ${errorText(error)}.`);
        }
      }

    if (render) occurrences.push(...flashOccurrences(measureFlashesInFile(render, fps)));
    else if (flashFromCaptures) {
      if (selected.every((frame) => flashCells.has(frame))) {
        const tracker = new FlashTracker();
        for (const frame of selected) tracker.push(flashCells.get(frame)!);
        occurrences.push(...flashOccurrences(tracker.report(fps), selected[0]));
      } else skipped.flashRisk = "a frame in the range did not render";
    }
    if (render)
      occurrences.push(
        ...checkRender(render, probeRender(render), {
          codec: options.codec ?? composition.defaultCodec ?? "h264",
          width,
          height,
          fps,
          durationInFrames,
          lastFrame: last,
        }),
      );

    const { kept: undeclared, intended: intendedOverflow } = splitIntended(
      dropTransits(occurrences, positions, { width, height }),
    );
    const { kept, allowed, unusedAllow } = applyAllow(undeclared, options.allow);
    const counters = tally(kept, skipped);
    const findings = mergeOccurrences(kept);
    return {
      failing: kept.length > 0,
      table: formatTable(pixels.size, counters),
      metadata: {
        composition: { id, width, height, fps, durationInFrames },
        frames: pixels.size,
        framesChecked: [...pixels.keys()],
        counters,
        findings: findings.slice(0, MAX_FINDINGS),
        findingsOmitted: Math.max(0, findings.length - MAX_FINDINGS),
        skipped,
        allowed,
        unusedAllow,
        intendedOverflow,
        textNodes,
        determinismChecked,
        determinismRetried,
        walkMs,
        msPerFrame: pixels.size ? Math.round(walkMs / pixels.size) : null,
        ...(finished ? {} : { abortedAfterFailedFrames: MAX_FAILED_FRAMES }),
        ...(safeZone ? { safeZone } : {}),
      },
    };
  });
}
