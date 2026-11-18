import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { MeshGradient } from "../backgrounds/MeshGradient";
import { AudioCurvesProvider, AudioReactive, pulse, useAudioCurve, type AudioCurveName } from "../../sync/curves";
import { demoCurves } from "../../sync/demo-curves";
import type { Cue } from "../types";

export const audioPulseDemoSchema = z.object({
  word: z.string(),
  ink: z.string(),
  base: z.string(),
  colours: z.array(z.string()).min(2).max(7),
  /** Scale added to the word on the strongest kick; the craft rules keep this at 0.03 or less. */
  kickScale: z.number().min(0).max(0.03),
  bpm: z.number().min(60).max(180),
  /** Shows the curves under the word, so an agent can see what each one does. */
  meters: z.boolean(),
});

export type AudioPulseDemoProps = z.infer<typeof audioPulseDemoSchema>;

const METERS: { name: AudioCurveName; label: string }[] = [
  { name: "kick", label: "kick" },
  { name: "low", label: "low" },
  { name: "energy", label: "energy" },
  { name: "beatPhase", label: "beat phase" },
];

const Meter: React.FC<{ name: AudioCurveName; label: string; ink: string; width: number }> = ({
  name,
  label,
  ink,
  width,
}) => {
  const value = useAudioCurve(undefined, name);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: width * 0.02 }}>
      <div
        style={{
          width: width * 0.2,
          fontFamily: primaryFont,
          fontSize: width * 0.026,
          color: ink,
          opacity: 0.7,
          textAlign: "right",
        }}
      >
        {label}
      </div>
      <div
        style={{
          width: width * 0.5,
          height: width * 0.012,
          background: `color-mix(in srgb, ${ink} 14%, transparent)`,
          borderRadius: 99,
        }}
      >
        <div style={{ width: `${value * 100}%`, height: "100%", background: ink, borderRadius: 99 }} />
      </div>
      <div
        style={{
          width: width * 0.08,
          fontFamily: primaryFont,
          fontVariantNumeric: "tabular-nums",
          fontSize: width * 0.024,
          color: ink,
          opacity: 0.7,
        }}
      >
        {value.toFixed(2)}
      </div>
    </div>
  );
};

/**
 * Audio-reactive motion from a synthetic 120 BPM curve fixture: the mesh drifts faster with the bass and the word
 * pulses on the kick, both from precomputed curves. In a film, wrap the scene in
 * `<AudioCurvesProvider src="projects/<id>/pipeline/curves.json">` and set `react` on the blocks that should follow.
 */
export const AudioPulseDemo: React.FC<AudioPulseDemoProps> = ({ word, ink, base, colours, kickScale, bpm, meters }) => {
  const { width, height } = useVideoConfig();
  const short = Math.min(width, height);
  return (
    <AudioCurvesProvider curves={demoCurves({ bpm })}>
      <AbsoluteFill>
        <MeshGradient
          base={base}
          colours={colours}
          speed={0.5}
          size={0.55}
          blend="normal"
          grain={0.06}
          seed="audio-pulse"
          react={{ amount: 0.8, hue: 6 }}
        />
        <AbsoluteFill
          style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: short * 0.08 }}
        >
          <AudioReactive name="kick" map={(value) => ({ transform: `scale(${pulse(value, kickScale)})` })}>
            <div
              style={{
                fontFamily: displayFont,
                fontWeight: 700,
                fontSize: short * 0.16,
                letterSpacing: "-0.04em",
                color: ink,
                whiteSpace: "pre",
              }}
            >
              {word}
            </div>
          </AudioReactive>
          {meters ? (
            <div style={{ display: "flex", flexDirection: "column", gap: short * 0.018 }}>
              {METERS.map((meter) => (
                <Meter key={meter.name} {...meter} ink={ink} width={short} />
              ))}
            </div>
          ) : null}
        </AbsoluteFill>
      </AbsoluteFill>
    </AudioCurvesProvider>
  );
};

export const audioPulseDemoDefaults: AudioPulseDemoProps = {
  word: "On the one",
  ink: "#141414",
  base: "#f3efe8",
  colours: ["#ff8a4c", "#ffd166", "#f25c7a", "#3bb3a0"],
  kickScale: 0.03,
  bpm: 120,
  meters: true,
};

export const AUDIO_PULSE_DEMO_FRAMES = 120;

/** The downbeats of the fixture: where the pulse is strongest. Silent: the music is the sound. */
export const audioPulseDemoCues = (props: AudioPulseDemoProps): Cue[] =>
  demoCurves({ bpm: props.bpm })
    .grid.downbeats.filter((frame) => frame < AUDIO_PULSE_DEMO_FRAMES)
    .map((frame) => ({
      frame: Math.round(frame),
      kind: "hit" as const,
      sfx: "none" as const,
      weight: "support" as const,
      label: "downbeat",
    }));
