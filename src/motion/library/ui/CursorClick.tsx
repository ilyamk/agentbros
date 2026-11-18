import React from "react";
import { z } from "zod";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Cursor } from "../../ui";
import { curves, progress, track, type PointKeyframe } from "../../timing";
import { DASHBOARD_DESIGN, DashboardScreen, ease, Fit, Icon, Stage, themeFor, uiFont, useFormat } from "./kit";
import { geistMono, surface } from "./surface";

export const cursorClickSchema = z.object({
  title: z.string(),
  body: z.string(),
  checks: z.array(z.string()),
  buttonLabel: z.string(),
  /** The next scene the click opens into: a title and one quiet line. */
  nextTitle: z.string(),
  nextLine: z.string(),
  /** Marks exactly one element: the button, which becomes the next ground. */
  accent: z.string(),
  /** Frame the press lands: put the click SFX here. */
  clickAt: z.number().int().min(20),
  /** Frames the cursor travels before it arrives over the button. */
  travel: z.number().int().min(8),
  /** Light or dark product; defaults to light. */
  tone: z.enum(["light", "dark"]).optional(),
});

export type CursorClickProps = z.infer<typeof cursorClickSchema>;

const CARD = { width: 820, height: 500 };
const BUTTON = { x: 500, y: 400, width: 280, height: 64 };

/** Points along a quadratic Bezier, eased, as dense keys for `Cursor` (whose own tracks are per-axis). */
export const bezierKeys = (
  from: { x: number; y: number },
  control: { x: number; y: number },
  to: { x: number; y: number },
  start: number,
  frames: number,
  curve = curves.inOut,
): PointKeyframe[] => {
  const steps = Math.max(2, Math.round(frames));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = curve(i / steps);
    const u = 1 - t;
    return {
      at: start + i,
      x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
      y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
    };
  });
};

/** Frame the iris from the click has filled the frame: cut to your next scene here. */
export const cursorClickCut = (clickAt: number) => clickAt + 4 + 7;

/**
 * A modal over the dimmed product: the cursor (5% of frame height) arcs in, hovers and presses the one accent button,
 * and the press opens an iris from the click point into the next scene, which the button's colour becomes.
 */
export const CursorClick: React.FC<CursorClickProps> = ({
  title,
  body,
  checks,
  buttonLabel,
  nextTitle,
  nextLine,
  accent,
  clickAt,
  travel,
  tone = "light",
}) => {
  const s = surface(tone, accent);
  const frame = useCurrentFrame();
  const { width, height } = useFormat();
  const scale = Math.min((height * 0.72) / CARD.height, (width * 0.66) / CARD.width);

  const target = { x: BUTTON.x + BUTTON.width * 0.56, y: BUTTON.y + BUTTON.height * 0.55 };
  const arrive = clickAt - 6;
  const keys: PointKeyframe[] = bezierKeys(
    { x: CARD.width + 300, y: CARD.height + 200 },
    { x: CARD.width * 0.6, y: CARD.height + 140 },
    target,
    arrive - travel,
    travel,
  );
  const hover = progress(frame, arrive - 4, 8, ease.arrive);
  const press = Math.max(0, 1 - Math.abs(frame - clickAt) / 4);
  const enter = progress(frame, 0, 18, ease.arrive);
  const push = track(frame, [
    { at: 0, value: 1 },
    { at: arrive - travel, value: 1 },
    { at: clickAt, value: 1.12, curve: ease.state },
  ]);

  const irisStart = clickAt + 4;
  const iris = progress(frame, irisStart, 7, ease.exit);
  const cardX = width / 2 - CARD.width / 2;
  const cardY = height / 2 - CARD.height / 2;
  const originX = width / 2 + (target.x - CARD.width / 2) * scale;
  const originY = height / 2 + (target.y - CARD.height / 2) * scale;
  const radius = iris * Math.hypot(Math.max(originX, width - originX), Math.max(originY, height - originY));
  const next = progress(frame, irisStart + 8, 16, ease.arrive);
  const cursorSize = (height * 0.05) / (scale * push);

  return (
    <Stage ground={s.ground}>
      <AbsoluteFill style={{ opacity: tone === "light" ? 0.7 : 0.45, filter: "blur(4px)" }}>
        <Fit design={DASHBOARD_DESIGN} width={width} height={height} cover>
          <DashboardScreen theme={themeFor(tone, accent)} />
        </Fit>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: tone === "light" ? "rgba(10,10,10,0.16)" : "rgba(0,0,0,0.5)" }} />
      <div
        style={{
          position: "absolute",
          left: cardX,
          top: cardY,
          width: CARD.width,
          height: CARD.height,
          transform: `translateY(${(1 - enter) * 30}px) scale(${scale * push})`,
          transformOrigin: `${target.x}px ${target.y}px`,
          opacity: enter,
          fontFamily: uiFont,
          color: s.text,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 22,
            background: s.card,
            border: `1px solid ${s.border}`,
            boxShadow: s.shadow.lg,
            padding: "40px 44px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: 12,
                background: s.muted,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="layers" size={24} color={s.text} />
            </div>
            <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.6 }}>{title}</div>
            <div
              style={{
                marginLeft: "auto",
                fontSize: 17,
                fontFamily: geistMono,
                color: s.mutedText,
                border: `1px solid ${s.border}`,
                background: s.muted,
                borderRadius: 8,
                padding: "4px 10px",
              }}
            >
              main · 4f2a91c
            </div>
          </div>
          <div style={{ marginTop: 18, fontSize: 20, lineHeight: 1.5, color: s.mutedText, maxWidth: 700 }}>{body}</div>
          <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 14 }}>
            {checks.slice(0, 4).map((c, i) => {
              const p = progress(frame, 8 + i * 2, 14, ease.arrive);
              return (
                <div
                  key={c}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    fontSize: 20,
                    color: s.text,
                    opacity: p,
                    filter: p < 1 ? `blur(${(1 - p) * 6}px)` : undefined,
                  }}
                >
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 13,
                      background: s.positive,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="check" size={16} color="#FFFFFF" stroke={2.6} />
                  </div>
                  {c}
                </div>
              );
            })}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 44,
            top: BUTTON.y,
            height: BUTTON.height,
            display: "flex",
            alignItems: "center",
            fontSize: 18,
            color: s.mutedText,
          }}
        >
          <Icon name="lock" size={18} color={s.mutedText} />
          <span style={{ marginLeft: 10 }}>Requires approval from 1 reviewer</span>
        </div>
        <div
          style={{
            position: "absolute",
            left: BUTTON.x,
            top: BUTTON.y,
            width: BUTTON.width,
            height: BUTTON.height,
            borderRadius: 14,
            background: `color-mix(in srgb, ${accent} ${Math.round(100 - hover * 10)}%, white)`,
            transform: `scale(${1 - press * 0.04})`,
            boxShadow: `0 ${8 + hover * 6}px ${24 + hover * 10}px -8px rgba(0,0,0,${tone === "light" ? 0.25 : 0.5})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            fontSize: 22,
            fontWeight: 600,
            color: "white",
          }}
        >
          {buttonLabel}
          <Icon name="arrow" size={20} color="white" stroke={2.2} />
        </div>
        {frame < irisStart + 7 ? (
          <Cursor keys={keys} clicks={[clickAt]} size={cursorSize} pulseColor="transparent" />
        ) : null}
      </div>
      {iris > 0 ? (
        <AbsoluteFill
          style={{
            background: accent,
            clipPath: `circle(${radius}px at ${originX}px ${originY}px)`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: uiFont,
            color: "white",
          }}
        >
          <div
            style={{ opacity: next, filter: next < 1 ? `blur(${(1 - next) * 8}px)` : undefined, textAlign: "center" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: height * 0.025,
                fontSize: height * 0.09,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                lineHeight: 1,
              }}
            >
              <Icon name="check" size={height * 0.08} color="white" stroke={2.6} />
              {nextTitle}
            </div>
            <div
              style={{
                marginTop: height * 0.03,
                fontSize: Math.max(30, height * 0.032),
                color: "rgba(255,255,255,0.72)",
              }}
            >
              {nextLine}
            </div>
          </div>
        </AbsoluteFill>
      ) : null}
    </Stage>
  );
};
