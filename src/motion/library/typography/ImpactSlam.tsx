import React from "react";
import { AbsoluteFill, Easing, useCurrentFrame } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { cyrillicCondensedFont } from "../../../lib/fonts-cyrillic";
import { ShockRing } from "../../backgrounds";
import { hitDecay, hitShake } from "../../kinetic-math";
import { EchoWord, Slam } from "../../kinetic-type";
import { MaskedLine } from "../../text";
import { progress } from "../../timing";

const EXIT = Easing.bezier(0.6, 0, 0.9, 0.35);
import { useSharedFit } from "./fit";
import { Stage, useSafeArea } from "./Stage";

export const impactSlamSchema = z.object({
  /** The word that lands. Capitals read best; the face is Sofia Sans Extra Condensed, Latin and Cyrillic. */
  word: z.string(),
  /** Small line that settles under the word after the hit; empty for none. */
  subline: z.string(),
  color: z.string(),
  /** Colour of the word on the hit frame, of the flash and the ring. */
  hitColor: z.string(),
  echoColor: z.string(),
  muted: z.string(),
  background: z.string(),
  /** Frame of the hit. */
  at: z.number(),
  /** "lens" falls from past the camera; "slam" grows from far away. */
  enter: z.enum(["lens", "slam"]),
  /** Strength of the camera kick in pixels. */
  shake: z.number().nonnegative(),
  /** 0 to 1: white-out on the hit frame. */
  flash: z.number().min(0).max(1),
  /** Shock ring leaving the hit. Off by default: rings read as a stock template. */
  ring: z.boolean(),
  /** Two outline echoes drifting apart behind the word. Off by default for the same reason. */
  echoes: z.boolean(),
  /** Frame the word zooms through the lens; -1 holds it. */
  exitAt: z.number(),
});

export type ImpactSlamProps = z.infer<typeof impactSlamSchema>;

/**
 * One word hits: it falls through the lens (or grows from far), the frame kicks and flashes, a shock ring leaves the
 * hit, and two outline echoes drift apart behind the word to give it depth. For the turn of a film, used once.
 */
export const ImpactSlam: React.FC<ImpactSlamProps> = ({
  word,
  subline,
  color,
  hitColor,
  echoColor,
  muted,
  background,
  at,
  enter,
  shake,
  flash,
  ring,
  echoes: withEchoes,
  exitAt,
}) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const text = word.toUpperCase();
  const size = useSharedFit(
    [{ text, fontFamily: cyrillicCondensedFont, fontWeight: 900, letterSpacing: "-0.01em" }],
    safe.width * 0.9,
    safe.vertical ? safe.height * 0.3 : safe.height * 0.62,
  );
  if (size === null) return <Stage background={background}>{null}</Stage>;

  const kick = hitShake(frame, at, { seed: "impact", amplitude: shake, frames: 10 });
  const white = hitDecay(frame, at, 7) * flash;
  const echoes = progress(frame, at + 1, 18, "expoOut");
  const leaving = exitAt >= 0 && frame >= exitAt;
  const spread = Math.max(0, frame - at) * 0.0007;
  const echoFade = (withEchoes ? 1 : 0) * echoes * (leaving ? 1 - progress(frame, exitAt, 3, "linear") : 1);
  const type: React.CSSProperties = {
    fontFamily: cyrillicCondensedFont,
    fontWeight: 900,
    fontSize: size,
    lineHeight: 0.86,
    letterSpacing: "-0.01em",
    textAlign: "center",
  };
  const sub = progress(frame, at + 8, 24, "expoOut") * (leaving ? 1 - progress(frame, exitAt - 4, 8, EXIT) : 1);

  return (
    <Stage background={background} grain={0.05}>
      <AbsoluteFill style={{ transform: `translate(${kick.x}px, ${kick.y}px) rotate(${kick.roll}deg)` }}>
        {ring ? <ShockRing hits={[at]} color={hitColor} from={size * 0.3} frames={16} strokeWidth={3} /> : null}
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              {echoFade > 0.01 ? (
                <>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      transform: `scale(${1 + 0.07 * echoes + spread})`,
                      opacity: echoFade,
                    }}
                  >
                    <EchoWord
                      text={text}
                      drift={0}
                      color={echoColor}
                      strokeWidth={Math.max(1.5, size * 0.006)}
                      opacity={0.5}
                      style={{ ...type, color: echoColor }}
                    />
                  </div>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      transform: `scale(${1 + 0.15 * echoes + spread * 2})`,
                      opacity: echoFade,
                    }}
                  >
                    <EchoWord
                      text={text}
                      drift={0}
                      color={echoColor}
                      strokeWidth={Math.max(1.5, size * 0.005)}
                      opacity={0.26}
                      style={{ ...type, color: echoColor }}
                    />
                  </div>
                </>
              ) : null}
              <Slam
                motion={{
                  at,
                  enter,
                  tilt: { x: 8, y: -14, z: -3 },
                  creep: 0,
                  exitAt: exitAt >= 0 ? exitAt : undefined,
                  exit: "through",
                }}
                halfWidth={size * text.length * 0.2}
                color={color}
                hitColor={hitColor}
                style={type}
              >
                {text}
              </Slam>
            </div>
            {subline ? (
              <div style={{ opacity: sub, marginTop: size * 0.08 }}>
                <MaskedLine
                  reveal={sub}
                  lineHeight={1.2}
                  style={{
                    fontFamily: primaryFont,
                    fontWeight: 600,
                    fontSize: Math.max(28, size * 0.11),
                    letterSpacing: "0.32em",
                    textTransform: "uppercase",
                    color: muted,
                    textAlign: "center",
                  }}
                >
                  {subline}
                </MaskedLine>
              </div>
            ) : null}
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
      {white > 0.01 ? <AbsoluteFill style={{ background: hitColor, opacity: white, mixBlendMode: "screen" }} /> : null}
    </Stage>
  );
};

export const impactSlamDefaults: ImpactSlamProps = {
  word: "Now",
  subline: "",
  color: "#F7F4EE",
  hitColor: "#FF5A36",
  echoColor: "#F7F4EE",
  muted: "rgba(247,244,238,0.6)",
  background: "#0B0A0C",
  at: 10,
  enter: "lens",
  shake: 10,
  flash: 0,
  ring: false,
  echoes: false,
  exitAt: 104,
};
