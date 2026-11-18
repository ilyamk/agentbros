import type { VisionEvent } from "../../types/vision-review";
import { attachVideoReview } from "../vision/review-adapters";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND, CUT_MARK, MUTED, RgbImage, TEXT, type Colour } from "../vision/image";
import { decodeFrame, decodeFrames, renderWaveform, writeImage, type VideoInfo } from "../vision/media";
import {
  buildShotSheet,
  buildStrip,
  composeGrid,
  formatTimecode,
  MAX_TILES,
  tileSize,
  type Cell,
} from "../vision/sheets";
import type {
  ReferenceAudio,
  ReferenceMotion,
  ReferenceShots,
  ReferenceSpeechText,
  ReferenceSync,
} from "../../types/reference";

const SHEET_COLUMNS = 9;
const SHEET_TILE_WIDTH = 220;
const STRIP_TILES = 12;
const STRIP_WIDTH = 240;
const THUMB_WIDTH = 480;
const BOUNDARY_TILES = 4;
const MAP_WIDTH = 2000;
const GUTTER = 96;

const TRANSITION_COLOURS: Record<string, Colour> = {
  cut: CUT_MARK,
  match: [255, 150, 60],
  dissolve: [90, 160, 255],
  fade: [150, 120, 255],
  wipe: [80, 220, 200],
  whip: [255, 90, 200],
  continuous: [240, 210, 70],
  unknown: MUTED,
};

const shotFirstFrame = (startSec: number, info: VideoInfo) =>
  Math.min(info.frameCount - 1, Math.ceil(startSec * info.fps - 1e-6));
const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

function shotStrip(media: string, info: VideoInfo, shot: ReferenceShots["shots"][number], output: string): string {
  const first = shotFirstFrame(shot.startSec, info);
  const last = Math.max(first, Math.min(info.frameCount - 1, Math.ceil(shot.endSec * info.fps - 1e-6) - 1));
  const step = Math.max(1, Math.ceil((last - first + 1) / STRIP_TILES));
  const { image } = buildStrip(media, info, {
    startFrame: first,
    endFrame: last,
    step,
    width: STRIP_WIDTH,
    columns: Math.min(6, STRIP_TILES),
  });
  return writeImage(image, output);
}

/** Frames either side of each boundary, to check by eye that it is real and what kind it is. */
function boundarySheets(media: string, info: VideoInfo, shots: ReferenceShots["shots"], directory: string): string[] {
  const perSheet = Math.floor(MAX_TILES / BOUNDARY_TILES);
  const { width, height } = tileSize(info, 200);
  return chunks(shots.slice(1), perSheet).map((group, index) => {
    const cells: Cell[] = [];
    for (const shot of group) {
      const centre = shotFirstFrame(shot.startSec, info);
      const start = shot.transitionStartSec === undefined ? centre : shotFirstFrame(shot.transitionStartSec, info);
      const end = shot.transitionEndSec === undefined ? centre : shotFirstFrame(shot.transitionEndSec, info);
      const frames =
        start === end
          ? [centre - 2, centre - 1, centre, centre + 1]
          : [start - 1, Math.round(start + (end - start) / 3), Math.round(start + (2 * (end - start)) / 3), end + 1];
      frames.forEach((frame, position) => {
        const decoded = decodeFrame(media, info, Math.max(0, Math.min(info.frameCount - 1, frame)), width, height);
        cells.push({
          image: decoded.image,
          label:
            position === 0
              ? `${shot.id} ${shot.transitionIn} ${shot.transitionConfidence}`
              : `F${decoded.frame} ${formatTimecode(decoded.frame / info.fps)}`,
        });
      });
    }
    return writeImage(
      composeGrid(cells, {
        title: `BOUNDARIES ${index + 1}: FRAMES ACROSS EACH TRANSITION`,
        columns: BOUNDARY_TILES * 3,
        groupSize: BOUNDARY_TILES,
      }),
      path.join(directory, `boundaries-${String(index + 1).padStart(2, "0")}.jpg`),
    );
  });
}

export function buildEditMap(request: {
  media: string;
  info: VideoInfo;
  shots?: ReferenceShots;
  audio?: ReferenceAudio;
  speechText?: ReferenceSpeechText;
  motion?: ReferenceMotion;
  sync?: ReferenceSync;
}): RgbImage {
  const { media, info, shots, audio, speechText, motion } = request;
  const duration = info.durationSec;
  const trackWidth = MAP_WIDTH - GUTTER - 8;
  const x = (seconds: number) => GUTTER + (seconds / duration) * trackWidth;
  const rowHeight = 26;
  const waveHeight = 150;
  const motionHeight = 80;
  const rows = ["TIME", "SHOTS", "WAVE", "BEATS", "ONSETS", "SPEECH", "TEXT ON", "MOTION"];
  const heights = [rowHeight, 48, waveHeight, 40, rowHeight, rowHeight, rowHeight, motionHeight];
  const total = heights.reduce((sum, value) => sum + value + 6, 0) + 44;
  const map = RgbImage.filled(MAP_WIDTH, total, BACKGROUND);
  const tempo = audio?.tempo;
  map.drawText(
    `EDIT MAP ${shots?.summary.count ?? 0} SHOTS ${tempo ? `${tempo.bpm.toFixed(1)} BPM CONF ${tempo.confidence.toFixed(2)}` : "NO TEMPO"} ${formatTimecode(duration)}`,
    8,
    8,
    2,
    MUTED,
  );
  let y = 32;
  const tops: Record<string, number> = {};
  rows.forEach((row, index) => {
    tops[row] = y;
    map.drawText(row, 6, y + 4, 1, MUTED);
    y += heights[index]! + 6;
  });
  const tick = (row: string, seconds: number, height: number, colour: Colour, thickness = 1) =>
    map.fillRect(x(seconds), tops[row]!, thickness, height, colour);

  const majorEvery = duration > 120 ? 30 : duration > 40 ? 5 : 1;
  for (let second = 0; second <= duration; second += majorEvery) {
    tick("TIME", second, 8, MUTED);
    map.drawText(
      `${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}`,
      x(second) + 2,
      tops.TIME! + 10,
      1,
      MUTED,
    );
  }
  (shots?.shots ?? []).forEach((shot, index) => {
    const shade: Colour = index % 2 ? [52, 54, 62] : [76, 78, 88];
    map.fillRect(x(shot.startSec), tops.SHOTS!, x(shot.endSec) - x(shot.startSec), 48, shade);
    if (shot.transitionStartSec !== undefined && shot.transitionEndSec !== undefined)
      map.fillRect(
        x(shot.transitionStartSec),
        tops.SHOTS!,
        Math.max(2, x(shot.transitionEndSec) - x(shot.transitionStartSec)),
        48,
        TRANSITION_COLOURS[shot.transitionIn] ?? MUTED,
      );
    if (x(shot.endSec) - x(shot.startSec) > 16)
      map.drawText(String(index + 1), x(shot.startSec) + 3, tops.SHOTS! + 4, 1, TEXT);
    if (index)
      map.drawText(
        shot.transitionIn.slice(0, Math.max(1, Math.floor((x(shot.endSec) - x(shot.startSec)) / 6))).toUpperCase(),
        x(shot.startSec) + 3,
        tops.SHOTS! + 30,
        1,
        TEXT,
      );
  });
  if (info.hasAudio) {
    try {
      map.blit(renderWaveform(media, duration, trackWidth, waveHeight), GUTTER, tops.WAVE!);
    } catch {
      map.drawText("WAVEFORM UNAVAILABLE", GUTTER, tops.WAVE! + 10, 2, MUTED);
    }
  } else map.drawText("NO AUDIO", GUTTER, tops.WAVE! + 10, 2, MUTED);
  for (const beat of tempo?.beatsSec ?? []) tick("BEATS", beat, 22, [120, 200, 255]);
  for (const downbeat of tempo?.downbeatsSec ?? []) tick("BEATS", downbeat, 40, [255, 255, 255], 2);
  for (const onset of audio?.onsetsSec ?? []) tick("ONSETS", onset, rowHeight, [110, 231, 183]);
  for (const word of speechText?.speech.words ?? [])
    map.fillRect(
      x(word.startSec),
      tops.SPEECH!,
      Math.max(1, x(word.endSec) - x(word.startSec) - 1),
      rowHeight,
      [235, 170, 90],
    );
  for (const item of speechText?.screenText.items ?? [])
    tick("TEXT ON", item.onsetSec ?? item.startSec, rowHeight, [250, 225, 90]);
  const curve = motion?.energyCurve ?? [];
  const peak = Math.max(...curve.map((row) => row.energy), 1e-6);
  for (const row of curve) {
    const height = (row.energy / peak) * motionHeight;
    map.fillRect(
      x(row.timeSec),
      tops.MOTION! + motionHeight - height,
      Math.max(1, trackWidth / Math.max(1, curve.length)),
      height,
      [190, 140, 255],
    );
  }
  // Cuts run through every track, so hits and misses against the sound show at a glance.
  for (const shot of (shots?.shots ?? []).slice(1))
    map.fillRect(
      x(shot.startSec),
      tops.SHOTS!,
      1,
      total - tops.SHOTS! - 6,
      TRANSITION_COLOURS[shot.transitionIn] ?? CUT_MARK,
    );
  return map;
}

/** Writes all visuals and returns relative paths for shots.json. */
export function buildVisuals(request: {
  directory: string;
  media: string;
  info: VideoInfo;
  shots: ReferenceShots;
  audio?: ReferenceAudio;
  speechText?: ReferenceSpeechText;
  motion?: ReferenceMotion;
  sync?: ReferenceSync;
}) {
  const { directory, media, info, shots } = request;
  const visuals = path.join(directory, "visuals");
  const relative = (file: string) => path.relative(directory, file).split(path.sep).join("/");
  mkdirSync(path.join(visuals, "strips"), { recursive: true });
  mkdirSync(path.join(visuals, "thumbs"), { recursive: true });
  const outputs: string[] = [];
  const reviewEvents: VisionEvent[] = [];
  const perSheet = Math.floor(MAX_TILES / 3);
  chunks(shots.shots, perSheet).forEach((group, index) => {
    // First and last frames come from the settled part of a shot, not the middle of a transition into or out of it.
    const settled = group.map((shot) => {
      const next = shots.shots[shots.shots.indexOf(shot) + 1];
      const startSec = shot.transitionEndSec ?? shot.startSec;
      const endSec = next?.transitionStartSec ?? shot.endSec;
      return endSec - startSec > 2 / info.fps ? { ...shot, startSec, endSec } : shot;
    });
    const { image, shots: report } = buildShotSheet(media, info, settled, {
      columns: SHEET_COLUMNS,
      width: SHEET_TILE_WIDTH,
    });
    outputs.push(writeImage(image, path.join(visuals, `contact-sheet-${String(index + 1).padStart(2, "0")}.jpg`)));
    reviewEvents.push(
      ...report.flatMap((shot) =>
        shot.frames.map((frame) => ({
          frame: frame.frame,
          clipId: shot.id,
          reasons: [`detector shot ${shot.id}: ${frame.position}; boundary remains a candidate`],
          basis: "measured" as const,
        })),
      ),
    );
  });
  const thumb = tileSize(info, THUMB_WIDTH);
  const withPaths = shots.shots.map((shot) => {
    const strip = shotStrip(media, info, shot, path.join(visuals, "strips", `${shot.id}.jpg`));
    const middle = Math.min(info.frameCount - 1, Math.round(((shot.startSec + shot.endSec) / 2) * info.fps));
    const [frame] = decodeFrames(media, info, {
      startFrame: middle,
      count: 1,
      width: thumb.width,
      height: thumb.height,
    });
    const thumbnail = frame ? writeImage(frame, path.join(visuals, "thumbs", `${shot.id}.jpg`)) : undefined;
    return { ...shot, stripPath: relative(strip), ...(thumbnail ? { thumbnailPath: relative(thumbnail) } : {}) };
  });
  outputs.push(...boundarySheets(media, info, shots.shots, visuals));
  outputs.push(writeImage(buildEditMap(request), path.join(visuals, "edit-map.png")));
  const review = attachVideoReview(media, visuals, reviewEvents, { profile: "reference" });
  outputs.push(...review.outputs);
  return {
    reviewPack: review.reviewPack,
    reviewWarnings: review.reviewWarnings,
    outputs,
    shots: { ...shots, shots: withPaths },
  };
}
