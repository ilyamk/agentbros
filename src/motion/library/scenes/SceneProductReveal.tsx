import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { StudioProductStage } from "../three/StudioProductStage";
import { getStyle } from "../styles";
import { HeroWord } from "../transitions/GroundSwap";
import { ARRIVE, groundRole, MaybeFinish, sceneBaseSchema, useLook } from "./shared";

export const sceneProductRevealSchema = sceneBaseSchema.extend({
  shape: z.enum(["phone", "card"]),
  /** Screen image (staticFile name or URL); empty draws the stage's procedural screen. */
  screenImage: z.string(),
  screenHeadline: z.string(),
  screenSubline: z.string(),
  /** Kept for old callers; not drawn (no kicker labels). */
  kicker: z.string(),
  headline: z.string(),
  subline: z.string(),
  /** Frame the headline beside the product starts. */
  textAt: z.number(),
  orbitDegrees: z.number().min(0).max(360),
  /** Share of the frame the product fills when the dolly lands; vertical keeps room for the headline above. */
  fill: z.number().min(0.3).max(1.2),
  /** Length of this shot when it sits inside a longer film; defaults to the composition length. */
  durationInFrames: z.number().int().positive().optional(),
});

export type SceneProductRevealProps = z.infer<typeof sceneProductRevealSchema>;

/**
 * The 3D product on a light studio sweep, set to one side; the headline lands beside it at title scale with one
 * small caption. No kicker, no glow: the product and one line carry the shot.
 */
export const SceneProductReveal: React.FC<SceneProductRevealProps> = ({
  styleId,
  finish,
  shape,
  screenImage,
  screenHeadline,
  screenSubline,
  headline,
  subline,
  textAt,
  orbitDegrees,
  fill,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const look = useLook(styleId);
  const { palette } = look;
  const light = groundRole(styleId, "light");
  const u = Math.min(width, height) / 1080;
  // The headline cuts in with a short rise behind a clip; the caption follows 8 frames later.
  const rise = interpolate(frame, [textAt, textAt + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ARRIVE,
  });
  const caption = frame >= textAt + 8;
  const share = vertical ? 0.84 : (getStyle(styleId).typeScale?.title ?? 0.4);
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="scene-product">
      <AbsoluteFill style={{ backgroundColor: light.ground }}>
        <AbsoluteFill
          style={{
            transform: vertical ? `translateY(${height * 0.12}px) scale(0.9)` : `translateX(${width * 0.21}px)`,
          }}
        >
          <StudioProductStage
            screenImage={screenImage}
            shape={shape}
            headline={screenHeadline}
            subline={screenSubline}
            bodyColour="#2a2b30"
            accent={palette.accent}
            background={light.ground}
            orbitDegrees={orbitDegrees}
            durationInFrames={durationInFrames}
            ground={light.ground}
            fill={vertical ? Math.min(fill, 0.72) : fill}
          />
        </AbsoluteFill>
        <div
          style={{
            position: "absolute",
            left: vertical ? 70 * u : width * 0.07,
            right: vertical ? 70 * u : undefined,
            top: vertical ? 200 * u : 0,
            height: vertical ? undefined : height,
            width: vertical ? undefined : width * 0.42,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: vertical ? "center" : "flex-start",
          }}
        >
          <div style={{ overflow: "hidden", opacity: rise > 0 ? 1 : 0 }}>
            <div style={{ transform: `translateY(${(1 - rise) * 60 * u}px)` }}>
              <HeroWord
                text={headline}
                ink={light.ink}
                widthShare={share}
                fontFamily={look.displayFamily}
                maxSize={260 * u}
                style={{ textAlign: vertical ? "center" : "left", lineHeight: 1 }}
              />
            </div>
          </div>
          {subline ? (
            <div
              style={{
                fontFamily: look.bodyFamily,
                fontVariationSettings: look.bodyAxes,
                fontWeight: 500,
                fontSize: 36 * u,
                lineHeight: 1.3,
                color: light.ink,
                opacity: caption ? 0.6 : 0,
                marginTop: 26 * u,
              }}
            >
              {subline}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </MaybeFinish>
  );
};

export const sceneProductRevealDefaults: SceneProductRevealProps = {
  styleId: "paper-signal",
  finish: true,
  shape: "phone",
  screenImage: "",
  screenHeadline: "Every frame, on purpose.",
  screenSubline: "Motion that knows where it is going.",
  kicker: "Introducing Apex",
  headline: "Meet Apex.",
  subline: "Launch films, directed in minutes.",
  textAt: 22,
  orbitDegrees: 60,
  fill: 0.88,
};
