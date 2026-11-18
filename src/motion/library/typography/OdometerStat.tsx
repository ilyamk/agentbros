import React from "react";
import { useCurrentFrame } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { raceValue } from "../../kinetic-math";
import { NumberRace } from "../../kinetic-type";
import { MaskedLine } from "../../text";
import { progress } from "../../timing";
import { Stage, useSafeArea } from "./Stage";

export const odometerStatSchema = z.object({
  /** Whole number the reels stop on. */
  value: z.number().int().nonnegative(),
  from: z.number().int().nonnegative(),
  prefix: z.string(),
  suffix: z.string(),
  label: z.string(),
  caption: z.string(),
  /** Character between groups of three digits: a thin space, comma or nothing. */
  separator: z.string(),
  color: z.string(),
  accent: z.string(),
  muted: z.string(),
  background: z.string(),
  at: z.number(),
  /** Frames the reels run. */
  frames: z.number().positive(),
});

export type OdometerStatProps = z.infer<typeof odometerStatSchema>;

/**
 * A headline figure on mechanical reels: columns roll and blur by their own speed and stop from the left, a progress
 * hairline fills with the value, then the label and caption rise from their masks. For the one number a film is about.
 */
export const OdometerStat: React.FC<OdometerStatProps> = ({
  value,
  from,
  prefix,
  suffix,
  label,
  caption,
  separator,
  color,
  accent,
  muted,
  background,
  at,
  frames,
}) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const digits = String(value).length;
  const groups = Math.floor((digits - 1) / 3);
  const units = digits * 0.66 + groups * 0.26 + (prefix.length + suffix.length) * 0.5;
  const size = Math.min((safe.width * 0.92) / units, safe.vertical ? safe.height * 0.24 : safe.height * 0.42);
  const share =
    (raceValue(frame, { at, frames, from, to: value, curve: "expoOut" }) - from) / Math.max(value - from, 1);
  const arrived = progress(frame, at, 10, "expoOut");
  const landed = at + frames * 0.72;
  const affix: React.CSSProperties = {
    fontSize: size * 0.62,
    fontWeight: 500,
    color: accent,
    letterSpacing: "-0.02em",
    lineHeight: 1,
    alignSelf: "flex-start",
    marginTop: size * 0.12,
  };

  return (
    <Stage background={background}>
      <div
        style={{
          position: "absolute",
          left: safe.side,
          right: safe.side,
          top: safe.top,
          bottom: safe.bottom,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: primaryFont,
        }}
      >
        {label ? (
          <MaskedLine
            reveal={progress(frame, at - 4, 22)}
            lineHeight={1.2}
            style={{
              fontSize: Math.max(28, size * 0.16),
              fontWeight: 600,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: muted,
              marginBottom: size * 0.1,
            }}
          >
            {label}
          </MaskedLine>
        ) : null}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            color,
            opacity: arrived,
            transform: `translateY(${(1 - arrived) * size * 0.08}px)`,
          }}
        >
          {prefix ? <span style={affix}>{prefix}</span> : null}
          <NumberRace
            at={at}
            frames={frames}
            from={from}
            to={value}
            size={size}
            separator={separator}
            style={{ fontWeight: 700, letterSpacing: "-0.04em", fontFeatureSettings: '"tnum" 1' }}
          />
          {suffix ? <span style={{ ...affix, marginLeft: size * 0.06 }}>{suffix}</span> : null}
        </div>
        <div
          style={{
            width: Math.min(safe.width * 0.7, size * units * 0.8),
            height: Math.max(3, size * 0.022),
            marginTop: size * 0.16,
            background: "rgba(255,255,255,0.1)",
            borderRadius: 99,
            overflow: "hidden",
            opacity: arrived,
          }}
        >
          <div
            style={{
              width: "100%",
              height: "100%",
              background: `linear-gradient(90deg, ${accent}00, ${accent})`,
              transform: `scaleX(${share})`,
              transformOrigin: "0% 50%",
              borderRadius: 99,
            }}
          />
        </div>
        <MaskedLine
          reveal={progress(frame, landed - 4, 26)}
          lineHeight={1.25}
          style={{
            fontSize: Math.max(28, size * 0.2),
            fontWeight: 500,
            color: muted,
            marginTop: size * 0.2,
            letterSpacing: "-0.01em",
          }}
        >
          {caption}
        </MaskedLine>
      </div>
    </Stage>
  );
};

export const odometerStatDefaults: OdometerStatProps = {
  value: 2480000,
  from: 0,
  prefix: "",
  suffix: "+",
  label: "",
  caption: "in the first week, without a single dropped frame",
  separator: " ",
  color: "#F5F7FA",
  accent: "#5B8CFF",
  muted: "rgba(245,247,250,0.56)",
  background: "#07090F",
  at: 8,
  frames: 56,
};
