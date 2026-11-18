import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { easeFamily } from "../../ease-family";
import { DEMO } from "../transitions/demo";
import { wallScale } from "./camera-plan";
import type { Cue } from "../types";

export type PullOutPlan = {
  /** Scale while the content populates (the close view), e.g. 1.2. */
  closeScale: number;
  /** Extra push of the slow drift by the time the pull starts, as a share of the scale (0.04 = 4%). */
  driftZoom: number;
  /** Sideways drift by the time the pull starts, in shares of the frame width (positive moves the view right). */
  driftX: number;
  /** Frame the pull-back starts. */
  pullAt: number;
  /** Frames of the pull-back: about 15 on expo.out. */
  pullFrames: number;
  /** Point the close view centres on, as shares of the stage. */
  focusX: number;
  focusY: number;
  /**
   * "single": one pull-back from the close view to 1. "two-stage": the first pull lands at `midScale`, then a second
   * one at `secondAt` jumps and settles to 1 on circ.out over `secondFrames` (about 38). "wall" (ugc-app person-wall):
   * power2.out over `pullFrames` (15) to `midScale`, then straight on into power1.out over `secondFrames` (51) to 1;
   * the reference cuts while it is still moving. Lay the wall out with `<VideoWall>` (VideoWall.tsx).
   */
  variant: "single" | "two-stage" | "wall";
  midScale: number;
  secondAt: number;
  secondFrames: number;
};

export type PullOutPose = { scale: number; x: number; y: number; stage: "drift" | "pull" | "second" | "rest" };

/** Scale and focus of the view at a frame, before translation. Pure. */
export const pullOutScale = (
  frame: number,
  plan: PullOutPlan,
): { scale: number; focus: number; stage: PullOutPose["stage"] } => {
  const { closeScale, driftZoom, pullAt, pullFrames, variant, midScale, secondAt, secondFrames } = plan;
  if (frame < pullAt) {
    // Constant speed: a camera drift, not an entrance, so linear is the measured curve here.
    const t = Math.max(0, frame) / Math.max(1, pullAt);
    return { scale: closeScale * (1 + driftZoom * t), focus: 1, stage: "drift" };
  }
  const start = closeScale * (1 + driftZoom);
  if (variant === "wall") return wallScale(frame, pullAt, start, midScale, pullFrames, secondFrames);
  const firstEnd = variant === "two-stage" ? midScale : 1;
  const p = easeFamily["expo.out"](Math.min((frame - pullAt) / pullFrames, 1));
  if (variant === "single" || frame < secondAt) {
    // Interpolate in log space so the apparent speed is even across scales.
    return { scale: start * (firstEnd / start) ** p, focus: 1 - p, stage: p < 1 ? "pull" : "rest" };
  }
  const q = easeFamily["circ.out"](Math.min((frame - secondAt) / secondFrames, 1));
  return { scale: midScale * (1 / midScale) ** q, focus: 0, stage: q < 1 ? "second" : "rest" };
};

/**
 * The whole pose: the close view drifts at constant speed while content lands, then pulls back on expo.out to the whole
 * result at scale 1 (optionally in two stages). The drift offset and the close focus both resolve to the centred
 * stage as the pull completes, and the stage is clamped so no edge ever shows. Pure.
 */
export const pullOutPose = (frame: number, plan: PullOutPlan, width: number, height: number): PullOutPose => {
  const { scale, focus, stage } = pullOutScale(frame, plan);
  const drift =
    frame < plan.pullAt ? plan.driftX * (Math.max(0, frame) / Math.max(1, plan.pullAt)) : plan.driftX * focus;
  const fx = (0.5 + (plan.focusX - 0.5) * focus + drift) * width;
  const fy = (0.5 + (plan.focusY - 0.5) * focus) * height;
  const clamp = (value: number, size: number) => Math.min(0, Math.max(size - size * scale, value));
  return { scale, x: clamp(width / 2 - fx * scale, width), y: clamp(height / 2 - fy * scale, height), stage };
};

/**
 * A click for each item placed and the pull-back as the hero reveal (and the second stage as support). For the wall,
 * `drops` holds the frame the first tiles appear; the second stage follows the first without a cue of its own.
 */
export const populatePullOutCues = (
  plan: Pick<PullOutPlan, "pullAt" | "variant" | "secondAt">,
  drops: readonly number[],
): Cue[] =>
  plan.variant === "wall"
    ? [
        ...drops.slice(0, 1).map((frame): Cue => ({
          frame,
          kind: "reveal",
          sfx: "none",
          weight: "support",
          label: "white tiles appear from the centre",
        })),
        { frame: plan.pullAt, kind: "reveal", sfx: "whoosh", weight: "hero", label: "pull back to the whole wall" },
      ]
    : [
        ...drops.map((frame): Cue => ({ frame, kind: "land", sfx: "click", weight: "support", label: "item placed" })),
        { frame: plan.pullAt, kind: "reveal", sfx: "whoosh", weight: "hero", label: "pull back to the whole result" },
        ...(plan.variant === "two-stage"
          ? [
              {
                frame: plan.secondAt,
                kind: "reveal",
                sfx: "whoosh",
                weight: "support",
                label: "second pull-back",
              } satisfies Cue,
            ]
          : []),
      ];

/** Frames items are placed: every `every` frames from `from`, with up to `jitter` frames of seeded variation, all before `until`. Pure. */
export const dropFrames = (
  count: number,
  from: number,
  every: number,
  jitter: number,
  until: number,
  seed = "populate",
): number[] => {
  const out: number[] = [];
  let at = from;
  for (let i = 0; i < count && at < until; i++) {
    out.push(at);
    at += every + Math.round((random(`${seed}-${i}`) - 0.5) * 2 * jitter);
  }
  return out;
};

/** Wraps a stage at frame size and moves it on the populate-then-pull-out pose. */
export const PopulatePullOut: React.FC<PullOutPlan & { ground?: string; children: React.ReactNode }> = ({
  ground = "#FFFFFF",
  children,
  ...plan
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const pose = pullOutPose(frame, plan, width, height);
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: ground }}>
      <AbsoluteFill
        style={{ transform: `translate(${pose.x}px, ${pose.y}px) scale(${pose.scale})`, transformOrigin: "0 0" }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const populatePullOutSchema = z.object({
  closeScale: z.number().min(1.05).max(4),
  driftZoom: z.number().min(0).max(0.2),
  driftX: z.number().min(-0.3).max(0.3),
  pullAt: z.number().int().min(1),
  pullFrames: z.number().int().min(4).max(40),
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  variant: z.enum(["single", "two-stage", "wall"]),
  midScale: z.number().min(1).max(3),
  secondAt: z.number().int().min(0),
  secondFrames: z.number().int().min(6).max(60),
  /** Preview only: events placed on the week board, one every `every` frames from `dropFrom`. */
  events: z.array(z.string()).min(1),
  dropFrom: z.number().int().min(0),
  every: z.number().int().min(2).max(12),
  /** Preview of `variant: "wall"`: columns and rows of the wall, and clips (or images) under public/ cycled over its tiles; none draws stand-ins. */
  wallCols: z.number().int().min(3).max(24).optional(),
  wallRows: z.number().int().min(2).max(16).optional(),
  clips: z.array(z.string()).optional(),
  /**
   * Preview of `variant: "wall"` (props of `<VideoWall>` and `<WallVignette>`): column scroll in tile heights a frame,
   * neighbours in opposite directions (ugc-app about 0.012); the wall's bow on a cylinder, half-angle in radians; and
   * the vignette's strength at the corners, darkening and softening the outer columns. Absent: off, as before.
   */
  wallScroll: z.number().min(0).max(0.1).optional(),
  wallCurve: z.number().min(0).max(1.2).optional(),
  wallVignette: z.number().min(0).max(1).optional(),
});

export type PopulatePullOutProps = z.infer<typeof populatePullOutSchema>;

export const POPULATE_PULL_OUT_FRAMES = 110;

export const populatePullOutDefaults: PopulatePullOutProps = {
  closeScale: 1.2,
  driftZoom: 0.04,
  driftX: 0.08,
  pullAt: 72,
  pullFrames: 15,
  focusX: 0.4,
  focusY: 0.5,
  variant: "single",
  midScale: 1.35,
  secondAt: 96,
  secondFrames: 38,
  events: [
    "Launch post",
    "Team sync",
    "Newsletter",
    "Thread",
    "Case study",
    "Live demo",
    "Recap reel",
    "Changelog",
    "Q&A",
    "Behind the scenes",
    "Poll",
    "Teaser",
  ],
  dropFrom: 8,
  every: 5,
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOTS = 4;

/** Where each event lands on the board: a seeded day and slot, never twice in one cell. Pure. */
const placeEvents = (count: number): { day: number; slot: number }[] => {
  const used = new Set<string>();
  const out: { day: number; slot: number }[] = [];
  for (let i = 0; out.length < count && i < count * 20; i++) {
    const day = Math.floor(random(`day-${i}`) * DAYS.length);
    const slot = Math.floor(random(`slot-${i}`) * SLOTS);
    if (used.has(`${day}-${slot}`)) continue;
    used.add(`${day}-${slot}`);
    out.push({ day, slot });
  }
  return out;
};

const TINTS = ["#FFE3CC", "#D9ECFF", "#DFF3E4", "#F3E1F7"];

/** A generic week planner that fills one event at a time. Unbranded. */
const WeekBoard: React.FC<{ events: string[]; drops: number[] }> = ({ events, drops }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const vertical = height > width;
  const margin = (vertical ? 0.05 : 0.06) * width;
  const top = height * (vertical ? 0.2 : 0.12);
  const boardW = width - margin * 2;
  const boardH = height - top - height * (vertical ? 0.2 : 0.08);
  const header = 64 * u;
  const colW = boardW / DAYS.length;
  const rowH = (boardH - header) / SLOTS;
  const cells = placeEvents(events.length);
  return (
    <AbsoluteFill style={{ backgroundColor: "#F6F1E7" }}>
      <div
        style={{
          position: "absolute",
          left: margin,
          top,
          width: boardW,
          height: boardH,
          borderRadius: 28 * u,
          background: "#FFFFFF",
          border: `${Math.max(1, 2 * u)}px solid rgba(18,18,18,0.08)`,
          overflow: "hidden",
        }}
      >
        {DAYS.map((day, i) => (
          <div
            key={day}
            style={{
              position: "absolute",
              left: i * colW,
              top: 0,
              width: colW,
              height: boardH,
              borderLeft: i === 0 ? undefined : `${Math.max(1, u)}px solid rgba(18,18,18,0.07)`,
            }}
          >
            <div
              style={{
                height: header,
                display: "flex",
                alignItems: "center",
                paddingLeft: 18 * u,
                fontFamily: primaryFont,
                fontWeight: 600,
                fontSize: (vertical ? 22 : 24) * u,
                color: DEMO.inkMuted,
              }}
            >
              {day}
            </div>
          </div>
        ))}
        {cells.map((cell, i) => {
          const at = drops[i];
          if (at === undefined || frame < at) return null;
          // Each event drops in over 3 frames: a small fall and a scale from 0.9; nothing else moves with it.
          const k = Math.min((frame - at) / 3, 1);
          const land = easeFamily["expo.out"](k);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: cell.day * colW + 10 * u,
                top: header + cell.slot * rowH + 8 * u - (1 - land) * 18 * u,
                width: colW - 20 * u,
                height: rowH - 16 * u,
                borderRadius: 14 * u,
                background: TINTS[i % TINTS.length],
                transform: `scale(${0.9 + 0.1 * land})`,
                opacity: Math.min(1, k * 2),
                padding: 14 * u,
                boxSizing: "border-box",
                fontFamily: primaryFont,
                fontWeight: 600,
                fontSize: (vertical ? 19 : 22) * u,
                lineHeight: 1.15,
                color: DEMO.ink,
              }}
            >
              {events[i]}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Library preview: a week board fills under a slow drift, then the camera pulls back to the whole week. */
export const PopulatePullOutPreview: React.FC<PopulatePullOutProps> = ({
  events,
  dropFrom,
  every,
  wallCols: _cols,
  wallRows: _rows,
  clips: _clips,
  ...plan
}) => {
  const drops = dropFrames(events.length, dropFrom, every, 1, plan.pullAt);
  return (
    <PopulatePullOut {...plan} ground="#F6F1E7">
      <WeekBoard events={events} drops={drops} />
    </PopulatePullOut>
  );
};
