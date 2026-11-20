import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { regionTransform } from "../../camera-math";
import { SharedCarry } from "../transitions/SharedCarry";
import { useSharedFit } from "../typography/fit";
import { inkOn } from "../typography/Stage";
import { Cursor } from "../../ui";
import { progress } from "../../timing";
import { CameraRead, readKeys, type ReadStop } from "../ui/CameraRead";
import { specimenRing } from "./transition-cut-plan";
import { TurnedRing } from "./TurnedRing";
import { captureTiming } from "./scene-plan";
import { useLook } from "./shared";

const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const plate = z.object({
  before: z.string().min(1),
  after: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  target: point,
  result: point,
  control: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  resultZoom: z.number().min(1).max(8).optional(),
});

export const captureProofSchema = z.object({
  landscape: plate,
  portrait: plate.optional(),
  beforeValue: z.string().regex(/^\d{1,4}$/),
  afterValue: z.string().regex(/^\d{1,4}$/),
  beforeLabel: z.string().min(1),
  afterLabel: z.string().min(1),
  performance: z
    .object({
      blocks: z.tuple([z.literal("ground-swap-cut"), z.literal("caused-morph")]),
      score: z.string().min(1).optional(),
    })
    .optional(),
  resultNames: z.array(z.string().min(1)).min(1).max(3).optional(),
  title: z.string().min(1),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
});

export type CaptureProofProps = z.infer<typeof captureProofSchema>;

export const CaptureProof: React.FC<{
  proof: CaptureProofProps;
  length: number;
  styleId: string;
  cutToGround?: boolean;
}> = ({ proof, cutToGround = false, length, styleId }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const u = Math.min(width, height) / 1080;
  const plate = vertical && proof.portrait ? proof.portrait : proof.landscape;
  const { displayFamily, bodyFamily } = useLook(styleId);
  const { click, carryAt, landing, reframeDelay, reframeDuration } = captureTiming(length, Boolean(plate.control));
  const specimen = Boolean(proof.performance);
  const entrance = specimen ? 1 - progress(frame, 0, 12, "expoOut") : 0;
  const exit = specimen && cutToGround ? progress(frame, length - 13, 12, "inOut") : 0;
  const front = specimen ? (frame >= landing ? "#d7ff42" : "#c2b3ff") : frame >= landing ? proof.accent : "#251f2d";
  const changed = frame >= landing;
  const settle = progress(frame, landing, 12, "expoOut");
  const viewport = { width: (vertical ? 960 : 1104) * u, height: (vertical ? 920 : 690) * u };
  const left = vertical ? 60 * u : width - viewport.width - 76 * u;
  const top = vertical ? height * 0.41 : (height - viewport.height) / 2;
  const approach = Math.round(click * 0.43);
  const overview = Math.round(click * 0.23);
  const target = plate.target;
  const stops: ReadStop[] = [
    { cx: 0.5, cy: 0.5, zoom: 1, move: 1, hold: overview },
    {
      cx: target.x,
      cy: target.y,
      zoom: specimen ? 2.65 : 2.05,
      move: approach,
      hold: landing + reframeDelay - overview - approach,
    },
    { cx: plate.result.x, cy: plate.result.y, zoom: plate.resultZoom ?? 1.4, move: reframeDuration, hold: length },
  ];
  const x = target.x * plate.width,
    y = target.y * plate.height;
  const cardW = (vertical ? 670 : 530) * u;
  const cardH = (vertical ? 340 : 395) * u;
  const stackLeft = vertical ? 76 * u : 72 * u;
  const stackTop = vertical ? 390 * u : height * 0.38;
  const badgeRing = { x: cardW * 0.82, y: cardH * 0.26, size: cardH * 0.4 };
  const fullRing = specimenRing(width, height);
  const lerp = (a: number, b: number) => a + (b - a) * exit;
  const numberSize = Math.min(
    cardH * 0.69,
    cardW / (0.7 * Math.max(proof.beforeValue.length, proof.afterValue.length)),
  );
  const numberStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    fontSize: numberSize,
    letterSpacing: "-.075em",
    fontWeight: 650,
    lineHeight: 0.88,
    fontVariantNumeric: "tabular-nums",
  };
  const tabs = Math.max(1, Math.min(12, Number(proof.beforeValue)));
  const kept = Math.max(
    1,
    Math.round(tabs * Math.min(1, Number(proof.afterValue) / Math.max(1, Number(proof.beforeValue)))),
  );
  const labels = [proof.beforeLabel, proof.afterLabel].map((text) => ({
    text,
    fontFamily: bodyFamily,
    fontWeight: 550,
  }));
  const labelSize = useSharedFit(labels, cardW - 60 * u, 47 * u);
  const headerTop = (vertical ? 152 : 62) * u;
  const titleSize = useSharedFit(
    [{ text: proof.title, fontFamily: bodyFamily, fontWeight: 650 }],
    width - 440 * u,
    52 * u,
  );
  const camera = regionTransform(carryAt, readKeys(stops, plate, viewport), viewport);
  const control = plate.control;
  const source = control
    ? {
        x: left + camera.x + (x - control.width / 2) * camera.scale,
        y: top + camera.y + (y - control.height / 2) * camera.scale,
        width: control.width * camera.scale,
        height: control.height * camera.scale,
        radius: 40 * u,
      }
    : undefined;
  const badgeHeight = control ? Math.min(54 * u, (width * 0.29 * control.height) / control.width) : 0;
  const badgeWidth = control ? (badgeHeight * control.width) / control.height : 0;
  const badge = {
    x: width - 66 * u - badgeWidth,
    y: headerTop + 4 * u,
    width: badgeWidth,
    height: badgeHeight,
    radius: badgeHeight / 2,
  };
  return (
    <AbsoluteFill
      style={{
        background: specimen ? "#171820" : "#eeeae2",
        color: specimen ? "#f2eedf" : "#201d20",
        fontFamily: bodyFamily,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 66 * u,
          right: 66 * u,
          top: headerTop,
          borderBottom: `${2 * u}px solid ${specimen ? "#827e89" : "#393139"}`,
          paddingBottom: 18 * u,
          fontSize: titleSize ?? 52 * u,
          fontWeight: 650,
          letterSpacing: "-.05em",
        }}
      >
        {proof.title}
      </div>
      <div
        style={{
          position: "absolute",
          left: stackLeft,
          top: stackTop,
          width: cardW,
          height: cardH,
          transformOrigin: "48% 50%",
          zIndex: exit > 0 ? 2 : undefined,
          transform: `translateX(${-entrance * width * 0.34}px) rotate(${-entrance * 13}deg) scale(${1 + exit * 20})`,
        }}
      >
        {Array.from({ length: tabs }, (_, i) => {
          const depth = tabs - 1 - i;
          const retract = depth >= kept ? progress(frame, click + Math.floor(i * 0.9), 16, "quadIn") : 0;
          const shift = depth * (vertical ? 8 : 7) * u;
          return (
            <div
              key={depth}
              style={{
                position: "absolute",
                width: cardW,
                height: cardH,
                clipPath: "polygon(0 0, 42% 0, 47% 7%, 100% 7%, 100% 100%, 0 100%)",
                background: depth === 0 ? front : depth % 2 === 0 ? "#a79cb4" : "#c4bac9",
                transformOrigin: "15% 80%",
                transform: `translate(${shift - retract * cardW * 0.78}px,${-shift * 1.45 - retract * cardH * 1.24}px) rotate(${-retract * (22 + i * 2)}deg)`,
                opacity: 1 - Math.pow(retract, 2),
              }}
            >
              {specimen && depth === 0 && exit === 0 ? (
                <TurnedRing {...badgeRing} pose={1 + frame * 0.023} spread={0.1 + entrance * 0.18} tint="#c8b6ff" />
              ) : null}
              {depth === 0 ? (
                <div
                  style={{
                    position: "absolute",
                    left: 30 * u,
                    right: 30 * u,
                    bottom: 30 * u,
                    color: specimen ? "#171820" : changed ? inkOn(proof.accent) : "white",
                    opacity: 1 - progress(exit, 0, 0.2),
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      height: numberSize * 0.9,
                      overflow: "hidden",
                      fontFamily: displayFamily,
                    }}
                  >
                    <div style={{ ...numberStyle, transform: `translateY(${-108 * settle}%)` }}>
                      {proof.beforeValue}
                    </div>
                    <div style={{ ...numberStyle, transform: `translateY(${108 * (1 - settle)}%)` }}>
                      {proof.afterValue}
                    </div>
                  </div>
                  <div
                    style={{
                      marginTop: 20 * u,
                      fontSize: labelSize ?? 47 * u,
                      fontWeight: 550,
                      letterSpacing: "-.035em",
                      lineHeight: 1.05,
                    }}
                  >
                    {changed ? proof.afterLabel : proof.beforeLabel}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left,
          top,
          overflow: "hidden",
          transform: `translateX(${entrance * width * 0.4}px) rotate(${entrance * 5}deg)`,
          borderRadius: 10 * u,
          boxShadow: "0 9px 28px #32253b18",
          outline: "1px solid #32253b30",
        }}
      >
        <CameraRead stage={plate} viewport={viewport} stops={stops} ground="#fafafa">
          {[plate.before, plate.after].map((src, index) => (
            <Img
              key={index}
              src={staticFile(src)}
              style={{
                position: "absolute",
                inset: 0,
                width: plate.width,
                height: plate.height,
                opacity: index === 0 || frame >= click ? 1 : 0,
              }}
            />
          ))}
          {specimen && control && frame > click - 16 && frame < click + 8 ? (
            <div
              style={{
                position: "absolute",
                left: x - control.width / 2 - 4,
                top: y - control.height / 2 - 4,
                width: control.width + 8,
                height: control.height + 8,
                borderRadius: 50,
                boxShadow: "0 0 0 1.8px #5538cc",
                transform: `scale(${1 + 0.28 * (1 - progress(frame, click - 16, 10))})`,
                opacity: progress(frame, click - 16, 7) * (1 - progress(frame, click + 2, 6)),
              }}
            />
          ) : null}
          <div style={{ opacity: 1 - progress(frame, click + 6, 7, "linear") }}>
            <Cursor
              size={23}
              keys={[
                { at: 0, x: x + 95, y: y + 140 },
                { at: Math.round(click * 0.34), x: x + 95, y: y + 140 },
                { at: click - 5, x, y, curve: "inOut" },
              ]}
              clicks={[click]}
              pulseColor="transparent"
            />
          </div>
        </CameraRead>
      </div>
      {exit > 0 ? (
        <AbsoluteFill style={{ zIndex: 3 }}>
          <TurnedRing
            x={lerp(stackLeft + badgeRing.x, fullRing.x)}
            y={lerp(stackTop + badgeRing.y, fullRing.y)}
            size={lerp(badgeRing.size, fullRing.size)}
            pose={lerp(1 + frame * 0.023, 0.82)}
            spread={lerp(0.1, 0.84)}
            tint="#99ac51"
          />
        </AbsoluteFill>
      ) : null}
      {control && source && frame >= carryAt ? (
        <SharedCarry
          before={null}
          after={null}
          at={carryAt}
          frames={18}
          from={source}
          to={badge}
          carry={(rect) => {
            const scale = rect.width / control.width;
            return (
              <div
                style={{
                  position: "absolute",
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                  borderRadius: rect.height / 2,
                  overflow: "hidden",
                }}
              >
                <Img
                  src={staticFile(plate.after)}
                  style={{
                    position: "absolute",
                    width: plate.width * scale,
                    height: plate.height * scale,
                    left: -(x - control.width / 2) * scale,
                    top: -(y - control.height / 2) * scale,
                  }}
                />
              </div>
            );
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
