import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { useFittedFontSize } from "../../text";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { studioAccent, studioInk, studioPaper } from "../ui/production-surface";

export const waveformWordsSchema = z.object({
  words: z
    .array(z.object({ text: z.string().min(1).max(18), at: z.number().int().nonnegative() }))
    .min(1)
    .max(8)
    .refine((words) => words.every((word, i) => !i || word.at > words[i - 1]!.at), "Word cues must ascend."),
  levels: z.array(z.number().min(0).max(1)).min(8).max(320),
  sampleEvery: z.number().int().positive(),
  ground: z.string(),
  accent: z.string(),
  ink: z.string(),
});
export type WaveformWordsProps = z.infer<typeof waveformWordsSchema>;
export const waveformWordsDefaults = {
  words: [
    { text: "Cut", at: 14 },
    { text: "with", at: 33 },
    { text: "intent.", at: 54 },
  ],
  levels: Array.from({ length: 104 }, (_, i) =>
    Math.max(...[14, 33, 54].map((cue) => (i < cue ? 0 : Math.exp(-(i - cue) / 7) * (0.52 + (i % 5) * 0.12)))),
  ),
  sampleEvery: 1,
  ground: studioInk,
  accent: studioAccent,
  ink: studioPaper,
} satisfies WaveformWordsProps;
export const waveformWordCues = (p: WaveformWordsProps): Cue[] =>
  p.words.map(({ text, at }) => ({ frame: at, kind: "type", sfx: "none", label: text }));
export const activeWaveformWord = (frame: number, words: WaveformWordsProps["words"]) =>
  words.reduce((active, { at }, index) => (frame >= at ? index : active), -1);
export const WaveformWords: React.FC<WaveformWordsProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = width / 1920;
  const text = p.words.map((word) => word.text).join(" ");
  const fontFamily = "Georgia, serif";
  const size = useFittedFontSize({ text, withinWidth: width * 0.82, fontFamily, letterSpacing: "-0.035em" });
  const active = activeWaveformWord(frame, p.words);
  return (
    <AbsoluteFill style={{ background: p.ground, color: p.ink, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: "16%",
          left: "9%",
          right: "9%",
          borderTop: "1px solid #BED1AC79",
          paddingTop: u * 19,
          font: `600 ${u * 24}px Arial, sans-serif`,
          letterSpacing: "0.12em",
        }}
      >
        AGENT BROS. PICTURES
      </div>
      <div
        style={{
          position: "absolute",
          left: "9%",
          right: "9%",
          top: "37%",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: "0.24em",
          fontSize: Math.min(height * 0.16, size ?? 0),
          letterSpacing: "-0.035em",
          lineHeight: 1,
          fontFamily,
        }}
      >
        {p.words.map(({ text: word, at }, i) => {
          const rise = progress(frame, at, 9, "expoOut");
          return (
            <span
              key={at}
              style={{
                transform: `translateY(${(1 - rise) * 0.15}em)`,
                opacity: rise,
                color: i === active ? p.accent : p.ink,
                whiteSpace: "nowrap",
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
      <svg
        viewBox="0 0 1000 120"
        preserveAspectRatio="none"
        style={{ position: "absolute", top: "63%", left: "10%", width: "80%", height: "13%" }}
        aria-hidden
      >
        <path d="M0 60h1000" stroke={p.ink} opacity="0.24" />
        {p.levels.map((level, i) => {
          const x = (1000 * (i + 0.5)) / p.levels.length;
          const elapsed = frame - i * p.sampleEvery;
          const extent = 1.5 + level * 46;
          return (
            <path
              key={i}
              d={`M${x} ${60 - extent}v${extent * 2}`}
              stroke={elapsed >= 0 ? p.accent : p.ink}
              opacity={elapsed >= 0 ? 0.9 : 0.2}
              strokeWidth={Math.min(3.8, 660 / p.levels.length)}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
