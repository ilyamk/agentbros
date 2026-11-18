import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { easeFamily } from "../../ease-family";
import { DEMO } from "../transitions/demo";
import { intendedOverflow } from "../overflow";
import type { Cue } from "../types";

export type ReframeShot = {
  /** Frame of the hard cut to this framing (the first shot's `at` is its start). */
  at: number;
  /** Scale of the stage: 1 is the whole interface, 7 a macro of one control. */
  scale: number;
  /** Point of the stage (shares of its width and height) the framing centres on; clamped so no edge shows. */
  x: number;
  y: number;
};

export type ReframeSettings = {
  /** Frames of the settle after each cut; 0 for a dead-still reframe. Measured: 16. */
  settleFrames?: number;
  /** How far the settle travels, as a share of the scale, in the direction of the cut (in on a punch-in). Measured: 2-4%. */
  settleShare?: number;
  /** Slow drift during each hold, in shares of the frame width per second (leftward when positive). */
  drift?: number;
  /**
   * Sideways settle after each cut, a share of the frame width over the same `settleFrames`: on a punch-in the picture
   * arrives this far left and slides right into place (the opposite on a pull-back). nexaa: about 0.125 at a constant
   * scale (`uiPunchReframeNexaaSettle`). Default 0.
   */
  settlePan?: number;
  fps?: number;
};

export type ReframePose = { index: number; scale: number; x: number; y: number };

/** Index of the shot on screen at a frame: the last whose `at` has passed. */
export const reframeIndex = (frame: number, shots: readonly ReframeShot[]): number => {
  let index = 0;
  shots.forEach((shot, i) => {
    if (frame >= shot.at) index = i;
  });
  return index;
};

/**
 * Transform of the stage at a frame (origin top-left: translate, then scale). Scale is never interpolated between
 * shots: each cut jumps to the next framing. After a cut the scale settles on expo.out from `settleShare` short of the
 * target, so a punch-in carries on in a little and a pull-back out a little, and each hold drifts slowly. Pure.
 */
export const reframePose = (
  frame: number,
  shots: readonly ReframeShot[],
  width: number,
  height: number,
  { settleFrames = 16, settleShare = 0.03, drift = 0, settlePan = 0, fps = 30 }: ReframeSettings = {},
): ReframePose => {
  const index = reframeIndex(frame, shots);
  const shot = shots[index]!;
  const previous = shots[index - 1];
  const k = frame - shot.at;
  const direction = previous ? Math.sign(shot.scale - previous.scale) || 1 : 0;
  const settle =
    settleFrames > 0 && direction !== 0 ? 1 - easeFamily["expo.out"](Math.min(Math.max(k / settleFrames, 0), 1)) : 0;
  const scale = shot.scale * (1 - direction * settleShare * settle);
  const shift = (drift * width * Math.max(0, k)) / fps + direction * settlePan * width * settle;
  const clamp = (value: number, size: number) => Math.min(0, Math.max(size - size * scale, value));
  return {
    index,
    scale,
    x: clamp(width / 2 - shot.x * width * scale - shift, width),
    y: clamp(height / 2 - shot.y * height * scale, height),
  };
};

/** A cut cue on every reframe after the first; the last (usually the macro on the action) is the hero. */
export const reframeCues = (shots: readonly ReframeShot[]): Cue[] =>
  shots.slice(1).map((shot, i, all) => ({
    frame: shot.at,
    kind: "cut",
    sfx: "tick",
    weight: i === all.length - 1 ? "hero" : "support",
    label: shot.scale > (shots[i]?.scale ?? 1) ? "punch in" : "reframe out",
  }));

/**
 * Hard-cut reframes of one interface or record at a list of scales and anchors instead of a zoom: wide, the field at
 * 2x as typing starts, wide again when the line outgrows the frame, the button at 7x. Each cut lands on motion, with an
 * optional short settle. Children are the stage at frame size; render real captures at 2x or more for the macro.
 */
export const UiPunchReframe: React.FC<
  ReframeSettings & { shots: readonly ReframeShot[]; ground?: string; children: React.ReactNode }
> = ({ shots, ground = "#FFFFFF", children, ...settings }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const pose = reframePose(frame, shots, width, height, { fps, ...settings });
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: ground }}>
      <AbsoluteFill
        {...intendedOverflow(pose.scale > 1.001, "ui-punch-reframe: a punch-in crops the interface")}
        style={{ transform: `translate(${pose.x}px, ${pose.y}px) scale(${pose.scale})`, transformOrigin: "0 0" }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const shotSchema = z.object({
  at: z.number().int().min(0),
  scale: z.number().min(1).max(12),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export const uiPunchReframeSchema = z.object({
  shots: z.array(shotSchema).min(2),
  settleFrames: z.number().int().min(0).max(30),
  settleShare: z.number().min(0).max(0.12),
  drift: z.number().min(-0.1).max(0.1),
  settlePan: z.number().min(-0.2).max(0.2).optional(),
  /** Preview only: the request that types into the field, one glyph a frame from `typeAt`. */
  query: z.string(),
  typeAt: z.number().int().min(0),
});

export type UiPunchReframeProps = z.infer<typeof uiPunchReframeSchema>;

export const UI_PUNCH_REFRAME_FRAMES = 104;

/** Stage layout of the preview interface, in shares of the frame. */
const FIELD = { left: 0.2, right: 0.8, y: 0.6, height: 0.1 };
const SEND = { x: 0.755, y: 0.6 };

export const uiPunchReframeDefaults: UiPunchReframeProps = {
  shots: [
    { at: 0, scale: 1, x: 0.5, y: 0.5 },
    { at: 18, scale: 2, x: 0.36, y: FIELD.y },
    { at: 50, scale: 1, x: 0.5, y: 0.5 },
    { at: 76, scale: 7, x: SEND.x, y: SEND.y },
  ],
  settleFrames: 16,
  settleShare: 0.03,
  drift: 0.006,
  query: "Find every invoice over $5,000 from last quarter",
  typeAt: 18,
};

/**
 * nexaa's cut-in (6.583 s, F158 at 24 fps), measured on the full frame (the re-crop) against ours with `motion:strip
 * --vs` over 6.45-7.15 s: the cut lands on the first typed glyph as ours does, but the framing then keeps its scale
 * (title-to-field distance constant within 1%) and slides right by about 0.125 of the width from the first punched frame:
 * 45% of it after 0.04 s, 75% after 0.12 s, 88% after 0.21 s, 95% after 0.29 s. Ours settled in scale (3%) and drifted the other way. An expo.out
 * pan over 16 frames at 30 fps follows it (42%, 79%, 92%, 98% at those times); spread over `uiPunchReframeDefaults`. The pull-back and macro cuts were not
 * measured: the pan mirrors on a pull-back by design.
 */
export const uiPunchReframeNexaaSettle = { settleFrames: 16, settleShare: 0, settlePan: 0.125, drift: 0 } as const;

/** A generic assistant window: a greeting, the prompt field with a caret, a send button. Unbranded. */
const PromptStage: React.FC<{ query: string; typeAt: number }> = ({ query, typeAt }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const typed = query.slice(0, Math.max(0, Math.min(query.length, frame - typeAt + 1)));
  const fieldH = Math.min(height * FIELD.height, 112 * u);
  const fieldTop = height * FIELD.y - fieldH / 2;
  const send = fieldH * 0.66;
  const caretOn = Math.floor(frame / 8) % 2 === 0 || typed.length < query.length;
  return (
    <AbsoluteFill style={{ backgroundColor: "#F1F1EE" }}>
      <div
        style={{
          position: "absolute",
          left: width * 0.06,
          top: height * 0.08,
          right: width * 0.06,
          bottom: height * 0.08,
          borderRadius: 24 * u,
          background: "#FFFFFF",
          border: `${Math.max(1, 2 * u)}px solid rgba(18,18,18,0.07)`,
        }}
      >
        <div style={{ position: "absolute", left: 32 * u, top: 28 * u, display: "flex", gap: 10 * u }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{ width: 14 * u, height: 14 * u, borderRadius: "50%", background: "rgba(18,18,18,0.14)" }}
            />
          ))}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: width * FIELD.left,
          top: fieldTop - 150 * u,
          fontFamily: primaryFont,
          fontWeight: 600,
          fontSize: 56 * u,
          letterSpacing: -1.5 * u,
          color: DEMO.ink,
        }}
      >
        What should I look for?
      </div>
      <div
        style={{
          position: "absolute",
          left: width * FIELD.left,
          width: width * (FIELD.right - FIELD.left),
          top: fieldTop,
          height: fieldH,
          borderRadius: fieldH / 2,
          background: "#FFFFFF",
          boxShadow: `0 0 0 ${Math.max(1, 2 * u)}px rgba(18,18,18,0.10), 0 ${10 * u}px ${30 * u}px rgba(18,18,18,0.06)`,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: fieldH * 0.4,
            right: fieldH * 1.1,
            top: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            fontFamily: primaryFont,
            fontWeight: 500,
            fontSize: fieldH * 0.3,
            color: typed ? DEMO.ink : DEMO.inkMuted,
            whiteSpace: "pre",
            overflow: "hidden",
          }}
        >
          {typed || "Ask anything"}
          <span
            style={{
              display: "inline-block",
              width: Math.max(1, 3 * u),
              height: fieldH * 0.36,
              marginLeft: 2 * u,
              background: DEMO.indigo,
              opacity: caretOn ? 1 : 0,
            }}
          />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: width * SEND.x - send / 2,
          top: height * SEND.y - send / 2,
          width: send,
          height: send,
          borderRadius: "50%",
          background: typed.length === query.length ? DEMO.indigo : DEMO.ink,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width={send * 0.46}
          height={send * 0.46}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </div>
    </AbsoluteFill>
  );
};

/** Library preview: a generic assistant window read by hard reframes while the request types. */
export const UiPunchReframePreview: React.FC<UiPunchReframeProps> = ({
  shots,
  settleFrames,
  settleShare,
  drift,
  settlePan,
  query,
  typeAt,
}) => (
  <UiPunchReframe
    shots={shots}
    settleFrames={settleFrames}
    settleShare={settleShare}
    drift={drift}
    settlePan={settlePan}
    ground="#F1F1EE"
  >
    <PromptStage query={query} typeAt={typeAt} />
  </UiPunchReframe>
);
