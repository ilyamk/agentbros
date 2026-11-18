import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { DeviceFrame, ScreenPlayback } from "../../ui";
import { progress, track } from "../../timing";
import {
  ContactShadow,
  ease,
  Fit,
  Glare,
  MOBILE_DESIGN,
  MobileScreen,
  phoneScreen,
  Reveal,
  Stage,
  themeFor,
  uiFont,
  useFormat,
  useStagger,
} from "./kit";
import { surface } from "./surface";

export const phoneHeroSchema = z.object({
  /** Screen content: the built-in finance app, or a screenshot from `public/`. */
  screen: z.enum(["app", "image"]),
  /** staticFile path or URL, used when `screen` is "image". */
  screenImage: z.string(),
  accent: z.string(),
  /** Headline beside (landscape) or above (vertical) the phone; empty hides the copy. */
  headline: z.string(),
  subline: z.string(),
  /** Yaw the phone settles at, degrees. Negative turns the screen to the left. */
  yaw: z.number(),
  /** Frame the glare crosses the screen. */
  glareAt: z.number().int().min(0),
  /** Ground, copy and app theme; defaults to light. The hardware stays dark. */
  tone: z.enum(["light", "dark"]).optional(),
});

export type PhoneHeroProps = z.infer<typeof phoneHeroSchema>;

const EDGE_LAYERS = 10;

/** A phone with real thickness rises and turns in perspective, a light band crosses its glass, a contact shadow grounds it. */
export const PhoneHero: React.FC<PhoneHeroProps> = ({
  screen,
  screenImage,
  accent,
  headline,
  subline,
  yaw,
  glareAt,
  tone = "light",
}) => {
  const s = surface(tone, accent);
  const frame = useCurrentFrame();
  const { width, height, portrait } = useFormat();
  const theme = themeFor(tone, accent);
  const hasCopy = headline.length > 0;

  const phoneW = portrait
    ? Math.min(width * 0.56, (height * (hasCopy ? 0.6 : 0.78)) / 2.1667)
    : Math.min(width * 0.26, (height * 0.8) / 2.1667);
  const phoneH = phoneW * (19.5 / 9);
  const cx = portrait ? width / 2 : hasCopy ? width * 0.66 : width / 2;
  const cy = portrait ? (hasCopy ? height * 0.6 : height / 2) : height / 2;

  const ry = track(frame, [
    { at: 0, value: yaw - 34 },
    { at: 40, value: yaw, curve: ease.arrive },
  ]);
  const rx = track(frame, [
    { at: 0, value: 18 },
    { at: 40, value: 5, curve: ease.arrive },
  ]);
  const rz = track(frame, [
    { at: 0, value: -6 },
    { at: 40, value: -2, curve: ease.arrive },
  ]);
  const rise = track(frame, [
    { at: 0, value: phoneH * 0.35 },
    { at: 40, value: 0, curve: ease.arrive },
  ]);
  const appear = progress(frame, 0, 16, "linear");
  const reveal = useStagger(
    ["header", "chart", "kpi-0", "side", "row-0", "row-1", "row-2", "row-3"],
    16,
    2,
    16,
    ease.arrive,
  );
  const glare = progress(frame, glareAt, 34, "drift");
  const scr = phoneScreen(phoneW);
  const radius = Math.round(phoneW * 0.14);
  const thickness = phoneW * 0.05;

  return (
    <Stage ground={s.ground} light={tone === "light" ? "rgba(255,255,255,0.9)" : "rgba(255,240,225,0.07)"}>
      <ContactShadow
        cx={cx + ry * 1.2}
        cy={cy + phoneH * 0.5 + 40 + rise * 0.3}
        width={phoneW * 1.1}
        opacity={(tone === "light" ? 0.28 : 0.55) * appear}
        spread={40}
      />
      <div
        style={{
          position: "absolute",
          left: cx - phoneW / 2,
          top: cy - phoneH / 2,
          width: phoneW,
          height: phoneH,
          perspective: phoneW * 5,
          opacity: appear,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            transformStyle: "preserve-3d",
            transform: `translateY(${rise}px) rotateZ(${rz}deg) rotateX(${rx}deg) rotateY(${ry}deg)`,
          }}
        >
          {Array.from({ length: EDGE_LAYERS }, (_, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: radius,
                transform: `translateZ(${-((i + 1) / EDGE_LAYERS) * thickness}px)`,
                background: `linear-gradient(90deg, #3a3d44, #1b1d22 18%, #2c2f36 50%, #17181c 82%, #3a3d44)`,
                boxShadow: i === 0 ? "inset 0 0 0 1.5px rgba(255,255,255,0.18)" : undefined,
              }}
            />
          ))}
          <div
            style={{
              position: "absolute",
              right: -3,
              top: phoneH * 0.24,
              width: 4,
              height: phoneH * 0.1,
              borderRadius: 3,
              background: "#2a2c31",
              transform: `translateZ(${-thickness / 2}px)`,
            }}
          />
          <DeviceFrame
            width={phoneW}
            style={{
              position: "absolute",
              inset: 0,
              boxShadow: "0 0 0 1.5px rgba(255,255,255,0.22), inset 0 0 0 1px rgba(255,255,255,0.08)",
            }}
          >
            {screen === "image" && screenImage ? (
              <ScreenPlayback kind="image" src={screenImage} />
            ) : (
              <Fit design={MOBILE_DESIGN} cover {...scr}>
                <MobileScreen theme={theme} reveal={reveal} />
              </Fit>
            )}
            <Glare p={glare} />
          </DeviceFrame>
        </div>
      </div>
      {hasCopy ? (
        <div
          style={{
            position: "absolute",
            left: portrait ? width * 0.1 : width * 0.08,
            width: portrait ? width * 0.8 : width * 0.42,
            top: portrait ? height * 0.08 : height / 2,
            transform: portrait ? undefined : "translateY(-50%)",
            textAlign: portrait ? "center" : "left",
            fontFamily: uiFont,
            color: s.text,
          }}
        >
          <Reveal p={progress(frame, 10, 20, ease.arrive)} dy={24}>
            <div style={{ fontSize: portrait ? 76 : 84, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: 1.02 }}>
              {headline}
            </div>
          </Reveal>
          <Reveal p={progress(frame, 15, 20, ease.arrive)} dy={14}>
            <div
              style={{
                marginTop: 26,
                fontSize: portrait ? 34 : 32,
                lineHeight: 1.35,
                color: s.mutedText,
                fontWeight: 450,
              }}
            >
              {subline}
            </div>
          </Reveal>
        </div>
      ) : null}
    </Stage>
  );
};
