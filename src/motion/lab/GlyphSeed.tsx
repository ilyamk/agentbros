import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicGroteskFont, cyrillicWideFont } from "../../lib/fonts-cyrillic";
import { useFittedFontSize } from "../text";
import { formatOf, splitGraphemes } from "../text-split";
import { progress, stagger } from "../timing";
import { bone, ultramarine } from "./palette";

const SEED = "lab-47";
const ROWS = ["ДЕТЕР", "МИНИЗМ"];
const WEIGHT = 800;

const GlyphRow: React.FC<{ text: string; offset: number; width: number }> = ({ text, offset, width }) => {
  const frame = useCurrentFrame();
  const fontSize = useFittedFontSize({ text, withinWidth: width, fontFamily: cyrillicWideFont, fontWeight: WEIGHT });
  if (fontSize === null) return null;
  const glyphs = splitGraphemes(text);
  const delays = stagger(glyphs.length, { kind: "seeded", seed: `${SEED}-${offset}`, step: 2.5, jitter: 1 });
  return (
    <div style={{ display: "flex", justifyContent: "space-between", width }}>
      {glyphs.map((glyph, i) => {
        const start = 4 + offset * 0.5 + delays[i]!;
        const p = progress(frame, start, 16, "overshoot");
        const seen = progress(frame, start, 3, "linear");
        const y = (1 - p) * (random(`${SEED}-y-${offset + i}`) > 0.5 ? 1 : -1) * fontSize * 0.5;
        const turn = (1 - p) * (random(`${SEED}-r-${offset + i}`) * 70 - 35);
        return (
          <div
            key={`${glyph}-${i}`}
            style={{
              position: "relative",
              fontFamily: cyrillicWideFont,
              fontWeight: WEIGHT,
              fontSize,
              lineHeight: 1.08,
              opacity: seen,
              transform: `translateY(${y}px) rotate(${turn}deg)`,
            }}
          >
            {glyph}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "100%",
                textAlign: "center",
                fontFamily: cyrillicGroteskFont,
                fontWeight: 500,
                fontSize: 26,
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
                opacity: 0.8 * progress(frame, 32, 10),
              }}
            >
              +{String(Math.round(start)).padStart(2, "0")}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Per-glyph transforms from a seeded stagger, with the delays printed under the glyphs: the randomness is on show. */
export const GlyphSeed: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = formatOf(width, height) !== "landscape";
  const side = vertical ? 60 : 72;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: ultramarine,
        color: bone,
        padding: vertical ? "200px 60px 300px" : "56px 72px",
        justifyContent: vertical ? "flex-end" : "space-between",
        gap: vertical ? 90 : 0,
      }}
    >
      <div
        style={{
          fontFamily: cyrillicGroteskFont,
          fontWeight: 600,
          fontSize: vertical ? 54 : 60,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          opacity: progress(frame, 28, 12),
        }}
      >
        Один сид — один результат.
        <br />
        <span style={{ opacity: 0.72 }}>Same seed, same frame.</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 44 }}>
        {ROWS.map((row, i) => (
          <GlyphRow key={row} text={row} offset={i * 10} width={width - side * 2} />
        ))}
      </div>
    </AbsoluteFill>
  );
};
