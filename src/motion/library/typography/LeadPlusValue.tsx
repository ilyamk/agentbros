import { loadFont as loadInstrumentSerif } from "@remotion/google-fonts/InstrumentSerif";
import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { groteskFace, serifFace } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, resolveInk } from "./Stage";

const { fontFamily: instrumentItalic } = loadInstrumentSerif("italic", { weights: ["400"], subsets: ["latin"] });
/** Italic serif for the value word; falls back to the upright serif stack (Cyrillic) where the italic has no glyph. */
const valueFace = `${instrumentItalic}, ${serifFace}`;

const beatSchema = z.object({
  /** Lead phrase; omitted or empty keeps the previous beat's lead. */
  lead: z.string().optional(),
  /** The word that changes each beat. */
  value: z.string().min(1),
  /** Ground colour of this beat; omitted cycles through `grounds`. */
  ground: z.string().optional(),
  /** Image under public/ (staticFile path) behind this beat, dimmed by `plateDim`; empty or omitted for a flat ground. */
  plate: z.string().optional(),
});

export const leadPlusValueSchema = z.object({
  beats: z.array(beatSchema).min(1),
  /** Frame of the first cut. */
  at: z.number().int().nonnegative(),
  /** Frames each beat holds (29-36 measured, near two beats of the track); the last holds `lastHold`. */
  hold: z.number().int().min(8).max(120),
  lastHold: z.number().int().min(8).max(240),
  /** Frames the value word fades up after each cut (8 measured). */
  valueFade: z.number().int().min(1).max(30),
  /** Frames the last line fades out at its end; 0 holds it to the end (it is the thumbnail). */
  fadeOut: z.number().int().min(0).max(30),
  /** Grounds the beats cycle through when they name none. */
  grounds: z.array(z.string()).min(1),
  /** Ground of the last beat (a swap to a light ground makes it the payoff); empty to keep the cycle. */
  lastGround: z.string(),
  /** Ink of the value word on the last beat. */
  lastAccent: z.string(),
  /** "auto" picks paper-white or near-black per ground. */
  ink: z.string(),
  /** Darkening over a plate, 0-1. */
  plateDim: z.number().min(0).max(1),
  /** Width of the longest line as a share of the frame width; every beat is set at that one size. */
  width: z.number().min(0.2).max(0.9),
  /** Weight of the sans lead (light reads as the quiet voice). */
  leadWeight: z.number().int().min(200).max(700),
  grain: z.number().min(0).max(0.2),
});

export type LeadPlusValueProps = z.infer<typeof leadPlusValueSchema>;

type Resolved = {
  lead: string;
  value: string;
  ground: string;
  plate: string;
  start: number;
  end: number;
  last: boolean;
};

/** Each beat with its lead carried forward, its ground and its frame span. */
export const leadPlusValueBeats = (p: LeadPlusValueProps): Resolved[] => {
  let lead = "";
  let start = p.at;
  return p.beats.map((beat, i) => {
    if (beat.lead !== undefined && beat.lead !== "") lead = beat.lead;
    const last = i === p.beats.length - 1;
    const ground = beat.ground ?? (last && p.lastGround ? p.lastGround : p.grounds[i % p.grounds.length]!);
    const span = last ? p.lastHold : p.hold;
    const resolved = { lead, value: beat.value, ground, plate: beat.plate ?? "", start, end: start + span, last };
    start += span;
    return resolved;
  });
};

/**
 * A chant in two voices: a fixed light sans lead phrase and an italic serif value word that changes each beat on a hard
 * cut, the lead on screen on the cut frame and the value fading up after it. The last beat can move to its own ground
 * with the value in an accent, so the list ends on its payoff.
 */
export const LeadPlusValue: React.FC<LeadPlusValueProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const beats = leadPlusValueBeats(p);
  const runs = beats.flatMap((b) => [
    {
      text: `${b.lead} `.replace(/ /g, " "),
      fontFamily: groteskFace,
      fontWeight: p.leadWeight,
      letterSpacing: "-0.02em",
    },
    {
      text: b.value,
      fontFamily: valueFace,
      fontWeight: 400,
      letterSpacing: "-0.01em",
      additionalStyles: { fontStyle: "italic" },
    },
  ]);
  const measured = useTextWidths(runs, 100);
  const beatIndex = beats.findIndex((b) => frame >= b.start && frame < b.end);
  const index = beatIndex >= 0 ? beatIndex : frame >= (beats.at(-1)?.end ?? 0) ? beats.length - 1 : -1;
  const beat = index >= 0 ? beats[index]! : null;
  const ground = beat?.ground ?? p.grounds[0]!;
  if (measured === null || beat === null)
    return (
      <Stage background={ground} grain={p.grain}>
        {null}
      </Stage>
    );

  const lineW100 = beats.map((_, i) => measured[i * 2]! + measured[i * 2 + 1]! * 1.06);
  const fontSize = Math.min((width * p.width * 100) / Math.max(...lineW100, 1), height * 0.16);
  const leadW = (measured[index * 2]! * fontSize) / 100;
  const valueW = (measured[index * 2 + 1]! * fontSize * 1.06) / 100;
  const left = (width - leadW - valueW) / 2;
  const cy = height / 2;
  const ink = resolveInk(p.ink, beat.plate ? "#000000" : ground);
  const valueInk = beat.last && p.lastAccent ? p.lastAccent : ink;
  const fade = progress(frame, beat.start, p.valueFade, "linear");
  // power1.out on the value word, as measured.
  const valueIn = 1 - (1 - fade) * (1 - fade);
  const out = beat.last && p.fadeOut > 0 ? 1 - progress(frame, beat.end - p.fadeOut, p.fadeOut, "expoIn") : 1;

  const base: React.CSSProperties = {
    position: "absolute",
    top: cy - fontSize * 0.62,
    height: fontSize * 1.24,
    display: "flex",
    alignItems: "center",
    fontSize,
    lineHeight: 1,
    whiteSpace: "pre",
  };
  return (
    <Stage background={ground} grain={p.grain}>
      {beat.plate ? (
        <AbsoluteFill>
          <Img src={staticFile(beat.plate)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${p.plateDim})` }} />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill style={{ opacity: out }}>
        <div
          style={{
            ...base,
            left,
            fontFamily: groteskFace,
            fontWeight: p.leadWeight,
            letterSpacing: "-0.02em",
            color: ink,
          }}
        >
          {beat.lead}
        </div>
        <div
          style={{
            ...base,
            left: left + leadW,
            width: valueW,
            fontFamily: valueFace,
            fontStyle: "italic",
            fontWeight: 400,
            letterSpacing: "-0.01em",
            fontSize: fontSize * 1.06,
            color: valueInk,
            opacity: valueIn,
          }}
        >
          {beat.value}
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

export const leadPlusValueDefaults: LeadPlusValueProps = {
  beats: [
    { lead: "Not", value: "faster" },
    { value: "louder" },
    { lead: "Just", value: "clearer" },
    { value: "calmer" },
    { value: "yours" },
  ],
  at: 0,
  hold: 30,
  lastHold: 50,
  valueFade: 8,
  fadeOut: 0,
  grounds: ["#141414", "#1F2A24", "#2A2320", "#17202B"],
  lastGround: "#FAFAF7",
  lastAccent: "#2F6F4E",
  ink: "auto",
  plateDim: 0.35,
  width: 0.36,
  leadWeight: 300,
  grain: 0.04,
};

export const leadPlusValueCues = (p: LeadPlusValueProps): Cue[] =>
  leadPlusValueBeats(p).flatMap((b, i) => [
    i === 0
      ? {
          frame: b.start,
          kind: "reveal" as const,
          sfx: "none" as const,
          weight: "support" as const,
          label: `${b.lead} ${b.value}`,
        }
      : {
          frame: b.start,
          kind: "cut" as const,
          sfx: b.last ? ("chime" as const) : ("tick" as const),
          weight: b.last ? ("hero" as const) : ("support" as const),
          label: `${b.lead} ${b.value}`,
        },
    ...(b.last && p.fadeOut > 0
      ? [{ frame: b.end - p.fadeOut, kind: "exit" as const, sfx: "none" as const, weight: "support" as const }]
      : []),
  ]);
