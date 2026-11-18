import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { inkIn, joltOffset, scanReveal, scrapPlan, stampPose } from "../../text-modes";
import { splitGraphemes } from "../../text-split";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle, type FaceName } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, resolveInk, useSafeArea } from "./Stage";

export const printTypeSchema = z.object({
  /** The word or short line printed onto the ground. */
  text: z.string().min(1),
  /**
   * "scan": built upward behind a thin coloured line on a frame step, with colour misregistration. "stamp": slammed from
   * twice its size and faint to solid, multiplied into the paper, with an optional frame jolt. "scrap": each glyph on its
   * own torn paper scrap with its own face, colour and tilt, landing a few frames apart. "ink": faint on the paper, then
   * full in one frame under a whole-frame flicker.
   */
  mode: z.enum(["scan", "stamp", "scrap", "ink"]),
  face: z.enum(FACE_NAMES),
  /** Width of the text as a share of the safe width. */
  width: z.number().min(0.2).max(1),
  ink: z.string(),
  ground: z.string(),
  /** Frame the print starts (scan line, stamp contact window, first scrap, ink snap). */
  at: z.number().int().nonnegative(),
  /** Scan: frames to complete (paper-style: about 32). Stamp: frames from big to contact (4). */
  frames: z.number().int().min(1).max(90),
  /** Scan: frames each drawing holds (2 = on twos, steps(16) over 32). */
  step: z.number().int().min(1).max(6),
  /** Scan line and misregistration colours: line first, then up to two offset plates. */
  colours: z.array(z.string()).min(1).max(3),
  /** Misregistration offset as a share of the type size; 0 for clean. */
  misregister: z.number().min(0).max(0.08),
  /** Stamp: rotation in degrees; scale and opacity it starts from. */
  rotate: z.number().min(-30).max(30),
  stampFrom: z.number().min(1).max(4),
  /** Stamp: a ruled box around the word, as a rubber stamp. */
  stampBox: z.boolean(),
  /** Stamp: whole-frame jolt after contact in px (0 for none) and its frames (paper-style: about 4). */
  jolt: z.number().min(0).max(40),
  joltFrames: z.number().int().min(1).max(12),
  /** Scrap: frames between scraps (2-3), scrap fills cycled per glyph (the glyph takes the ink that reads on it), faces drawn from. */
  scrapStep: z.number().min(1).max(8),
  scrapColours: z.array(z.string()).min(1),
  scrapFaces: z.array(z.enum(FACE_NAMES)).min(1),
  /** Scrap: largest tilt in degrees. */
  tilt: z.number().min(0).max(25),
  /** Ink: contrast before the snap (paper-style: about 0.15) and frames of the flicker after it (12). */
  faint: z.number().min(0).max(0.6),
  flickerFrames: z.number().int().min(0).max(30),
  seed: z.string(),
  grain: z.number().min(0).max(0.2),
});

export type PrintTypeProps = z.infer<typeof printTypeSchema>;

/** Frame the print completes: the scan's last drawing, the stamp's contact, the last scrap's landing, the ink snap. */
export const printTypeLandFrame = (p: PrintTypeProps): number => {
  if (p.mode === "scan") return p.at + Math.max(0, Math.ceil(p.frames / p.step) - 1) * p.step;
  if (p.mode === "stamp") return p.at + p.frames;
  if (p.mode === "scrap") {
    const plan = scrapPlan(splitGraphemes(p.text), {
      at: p.at,
      step: p.scrapStep,
      faces: p.scrapFaces.length,
      colours: p.scrapColours.length,
      tilt: p.tilt,
      seed: p.seed,
    });
    return Math.max(p.at, ...plan.flatMap((scrap) => (scrap ? [scrap.land] : [])));
  }
  return p.at;
};

/**
 * Type printed onto a paper ground, in one of four print gestures from the same reference: a scan line that builds the
 * word upward on twos, a rubber stamp slam, pasted scrap letters, and a title that inks in from faint under a flicker.
 */
export const PrintType: React.FC<PrintTypeProps> = (p) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const set = faceStyle(p.face);
  const text = set.textTransform === "uppercase" ? p.text.toUpperCase() : p.text;
  const glyphs = splitGraphemes(text);
  const measured = useTextWidths([faceRun(p.face, p.text)], 100);
  if (measured === null)
    return (
      <Stage background={p.ground} grain={p.grain}>
        {null}
      </Stage>
    );
  const fit = p.mode === "scrap" ? 0.8 : p.mode === "stamp" && p.stampBox ? 0.82 : 1;
  const size = Math.min(
    safe.height * (safe.vertical ? 0.3 : 0.55),
    (safe.width * p.width * fit * 100) / Math.max(measured[0]!, 1),
  );
  const ink = resolveInk(p.ink, p.ground);
  const type: React.CSSProperties = {
    ...set,
    textTransform: undefined,
    fontSize: size,
    lineHeight: 1,
    whiteSpace: "pre",
  };

  if (p.mode === "scan") {
    const shown = scanReveal(frame, p.at, p.frames, p.step);
    if (shown <= 0)
      return (
        <Stage background={p.ground} grain={p.grain}>
          {null}
        </Stage>
      );
    // The line rises from the baseline region to the cap line; the text below it is printed.
    const clip = `inset(${((1 - shown) * 100).toFixed(2)}% -5% -5% -5%)`;
    const off = p.misregister * size;
    const [line, plateA, plateB] = [
      p.colours[0]!,
      p.colours[1] ?? p.colours[0]!,
      p.colours[2] ?? p.colours[1] ?? p.colours[0]!,
    ];
    return (
      <Stage background={p.ground} grain={p.grain}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative" }}>
            <div style={{ clipPath: clip }}>
              {off > 0 ? (
                <div
                  style={{
                    ...type,
                    position: "absolute",
                    left: -off,
                    top: off * 0.6,
                    color: plateA,
                    mixBlendMode: "multiply",
                    opacity: 0.9,
                  }}
                >
                  {text}
                </div>
              ) : null}
              {off > 0 ? (
                <div
                  style={{
                    ...type,
                    position: "absolute",
                    left: off,
                    top: -off * 0.4,
                    color: plateB,
                    mixBlendMode: "multiply",
                    opacity: 0.9,
                  }}
                >
                  {text}
                </div>
              ) : null}
              <div style={{ ...type, position: "relative", color: ink, mixBlendMode: "multiply" }}>{text}</div>
            </div>
            {shown < 1 ? (
              <div
                style={{
                  position: "absolute",
                  left: -size * 0.12,
                  right: -size * 0.12,
                  top: `${(1 - shown) * 100}%`,
                  height: Math.max(2, size * 0.025),
                  backgroundColor: line,
                }}
              />
            ) : null}
          </div>
        </AbsoluteFill>
      </Stage>
    );
  }

  if (p.mode === "stamp") {
    const pose = stampPose(frame, p.at, p.frames, p.stampFrom, 0.3);
    const shake = joltOffset(frame, p.at + p.frames, p.joltFrames, p.jolt, p.seed);
    const box = p.stampBox
      ? {
          border: `${Math.max(3, size * 0.07)}px solid ${ink}`,
          borderRadius: size * 0.08,
          padding: `${size * 0.08}px ${size * 0.22}px`,
        }
      : {};
    // The jolt moves what is printed on the sheet; a flat ground looks the same shifted, so it stays put and no edge shows.
    return (
      <Stage background={p.ground} grain={p.grain}>
        {pose.visible ? (
          <AbsoluteFill
            style={{
              alignItems: "center",
              justifyContent: "center",
              transform: shake.x || shake.y ? `translate(${shake.x}px, ${shake.y}px)` : undefined,
            }}
          >
            <div
              style={{
                ...type,
                color: ink,
                mixBlendMode: "multiply",
                opacity: pose.opacity,
                transform: `rotate(${p.rotate}deg) scale(${pose.scale})`,
                ...box,
              }}
            >
              {text}
            </div>
          </AbsoluteFill>
        ) : null}
      </Stage>
    );
  }

  if (p.mode === "scrap") {
    const plan = scrapPlan(glyphs, {
      at: p.at,
      step: p.scrapStep,
      faces: p.scrapFaces.length,
      colours: p.scrapColours.length,
      tilt: p.tilt,
      seed: p.seed,
    });
    return (
      <Stage background={p.ground} grain={p.grain}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: size * 0.04 }}>
            {glyphs.map((glyph, i) => {
              const scrap = plan[i];
              if (!scrap) return <span key={i} style={{ width: size * 0.3 }} />;
              // Every scrap keeps its place from the start (hidden until it lands), so nothing reflows.
              const landed = frame >= scrap.land;
              const face: FaceName = p.scrapFaces[scrap.face]!;
              const fill = p.scrapColours[scrap.colour]!;
              const settle = Math.min(1, Math.max(0, (frame - scrap.land) / 2));
              const glyphSet = faceStyle(face);
              return (
                <span
                  key={i}
                  style={{
                    position: "relative",
                    display: "inline-block",
                    visibility: landed ? "visible" : "hidden",
                    transform: `translateY(${scrap.lift * size}px) rotate(${scrap.rotate}deg) scale(${1.12 - 0.12 * settle})`,
                    filter: `drop-shadow(0 ${size * 0.02}px ${size * 0.02}px rgba(0,0,0,0.25))`,
                  }}
                >
                  <span style={{ position: "absolute", inset: 0, backgroundColor: fill, clipPath: scrap.clip }} />
                  <span
                    style={{
                      ...glyphSet,
                      textTransform: undefined,
                      position: "relative",
                      display: "inline-block",
                      fontSize: size,
                      lineHeight: 1,
                      padding: `${size * 0.08}px ${size * 0.1}px`,
                      color: resolveInk("auto", fill),
                    }}
                  >
                    {glyphSet.textTransform === "uppercase" ? glyph.toUpperCase() : glyph}
                  </span>
                </span>
              );
            })}
          </div>
        </AbsoluteFill>
      </Stage>
    );
  }

  const level = inkIn(frame, p.at, p.faint, p.flickerFrames, p.seed);
  return (
    <Stage background={p.ground} grain={p.grain}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ ...type, color: ink, opacity: level.ink, mixBlendMode: "multiply" }}>{text}</div>
      </AbsoluteFill>
      {level.flicker !== 0 ? (
        <AbsoluteFill
          style={{
            backgroundColor: level.flicker > 0 ? "#FFFFFF" : "#000000",
            opacity: Math.abs(level.flicker) * 0.35,
          }}
        />
      ) : null}
    </Stage>
  );
};

export const printTypeDefaults: PrintTypeProps = {
  text: "Today",
  mode: "scan",
  face: "grotesk",
  width: 0.62,
  ink: "#1C1A17",
  ground: "#EDE6D6",
  at: 0,
  frames: 32,
  step: 2,
  colours: ["#F08A3C", "#2BB3D9", "#E8C547"],
  misregister: 0.022,
  rotate: -8,
  stampFrom: 2,
  stampBox: true,
  jolt: 10,
  joltFrames: 4,
  scrapStep: 2.5,
  scrapColours: ["#F4EFE2", "#D93A2B", "#1C1A17", "#E8C547", "#2D5BA8"],
  scrapFaces: ["grotesk", "serif", "condensed", "wide"],
  tilt: 8,
  faint: 0.15,
  flickerFrames: 12,
  seed: "print",
  grain: 0.06,
};

/** paper-style's stamp: a red rubber-stamp word slammed from 2x faint to solid in 4 frames, the frame jolting on contact. */
export const printTypeStampPreset: PrintTypeProps = {
  ...printTypeDefaults,
  text: "Approved",
  mode: "stamp",
  face: "condensed",
  ink: "#C8372D",
  at: 20,
  frames: 4,
  width: 0.5,
};
/** paper-style's pasted letters: a scrap per glyph, 2-3 frames apart. */
export const printTypeScrapPreset: PrintTypeProps = {
  ...printTypeDefaults,
  text: "Hello",
  mode: "scrap",
  at: 6,
  width: 0.6,
};
/** paper-style's title that inks in: faint across the hold, black in one frame under a 12-frame flicker. */
export const printTypeInkPreset: PrintTypeProps = {
  ...printTypeDefaults,
  text: "The end",
  mode: "ink",
  face: "serif",
  at: 40,
  width: 0.5,
};

export const printTypeCues = (p: PrintTypeProps): Cue[] => {
  const land = printTypeLandFrame(p);
  if (p.mode === "scan")
    return [
      { frame: p.at, kind: "reveal", sfx: "riser", weight: "support", label: "scan line starts" },
      { frame: land, kind: "land", sfx: "none", weight: "hero", label: "word printed" },
    ];
  if (p.mode === "stamp") return [{ frame: land, kind: "hit", sfx: "impact", weight: "hero", label: "stamp contact" }];
  if (p.mode === "scrap") {
    const plan = scrapPlan(splitGraphemes(p.text), {
      at: p.at,
      step: p.scrapStep,
      faces: p.scrapFaces.length,
      colours: p.scrapColours.length,
      tilt: p.tilt,
      seed: p.seed,
    });
    const lands = plan.flatMap((scrap) => (scrap ? [scrap.land] : []));
    return lands.map((frame, i) => ({
      frame,
      kind: i === lands.length - 1 ? ("land" as const) : ("reveal" as const),
      sfx: "click" as const,
      weight: i === lands.length - 1 ? ("hero" as const) : ("support" as const),
      label: "scrap lands",
    }));
  }
  return [{ frame: p.at, kind: "hit", sfx: "impact", weight: "hero", label: "title inks in" }];
};
