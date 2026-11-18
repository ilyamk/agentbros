import { evolvePath } from "@remotion/paths";
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { Camera, DepthLayer } from "../camera";
import { shake } from "../camera-math";
import { FilmGrain } from "../fx";
import { progress, track } from "../timing";
import { bone, graphite, ink, paper, signal } from "./palette";
import { REEL_LAYOUT } from "./reel-layout";

const NAMES: Record<string, string> = {
  poster: "Плакат, маски",
  whip: "Три хлыста",
  beat: "Слова на бит",
  glyph: "Глифы с сидом",
  weight: "Волна веса",
  shutter: "Затвор",
  camera: "Этот лист",
  play: "Вытеснение фигурой",
  studio: "Настоящий интерфейс",
  sunrise: "Склейка по точке",
};

const ROW_HEIGHT = 74;
const TABLE_TOP = 214;
const CIRCLED = REEL_LAYOUT.scenes.findIndex(({ id }) => id === "camera");
const PENCIL = "M 30 42 C 60 2, 400 -8, 760 4 S 1176 12, 1164 44 C 1150 82, 760 92, 400 88 S 2 84, 16 34";

const Sheet: React.FC<{ x: number; y: number; w: number; h: number; turn: number; children: React.ReactNode }> = ({
  x,
  y,
  w,
  h,
  turn,
  children,
}) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: w,
      height: h,
      backgroundColor: bone,
      color: ink,
      transform: `rotate(${turn}deg)`,
      boxShadow: "0 30px 70px -10px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.3)",
    }}
  >
    {children}
  </div>
);

/** A virtual camera over stacked paper: push, pan, rack from the back sheet to the table, handheld throughout. Every number is the real reel timeline. */
export const ShotListCamera: React.FC = () => {
  const frame = useCurrentFrame();
  const hand = shake(frame, { seed: "shot-list", amplitude: 5, frequency: 0.045, rollAmplitude: 0.12 });
  const pose = {
    x:
      track(frame, [
        { at: 0, value: -170 },
        { at: 92, value: 90, curve: "drift" },
      ]) + hand.x,
    y:
      track(frame, [
        { at: 0, value: 30 },
        { at: 92, value: -44, curve: "drift" },
      ]) + hand.y,
    dolly: track(frame, [
      { at: 0, value: 0 },
      { at: 92, value: 330, curve: "drift" },
    ]),
    roll: hand.roll,
    focus: track(frame, [
      { at: 10, value: 700 },
      { at: 46, value: 0, curve: "inOut" },
    ]),
  };
  const pencil = evolvePath(progress(frame, 56, 26, "drift"), PENCIL);
  const { scenes, totalFrames } = REEL_LAYOUT;
  return (
    <AbsoluteFill>
      <Camera pose={pose} lens={{ focal: 1400, aperture: 0.024, rackScale: 0 }} style={{ backgroundColor: "#1B1A17" }}>
        <DepthLayer depth={700} overscan={400}>
          <Sheet x={280} y={150} w={1400} h={1330} turn={-3.5}>
            <div
              style={{
                padding: "70px 90px",
                fontFamily: cyrillicCondensedFont,
                fontWeight: 800,
                fontSize: 300,
                lineHeight: 0.88,
                letterSpacing: "-0.005em",
              }}
            >
              МОНТАЖНЫЙ
              <br />
              ЛИСТ
            </div>
          </Sheet>
        </DepthLayer>
        <DepthLayer depth={0}>
          <Sheet x={500} y={70} w={1180} h={1030} turn={1.1}>
            <div style={{ padding: "52px 40px 0", fontFamily: cyrillicGroteskFont }}>
              <div style={{ fontFamily: cyrillicCondensedFont, fontWeight: 800, fontSize: 96, lineHeight: 1 }}>
                КАЖДАЯ СКЛЕЙКА ПОСЧИТАНА
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 24,
                  fontWeight: 600,
                  color: graphite,
                  marginTop: 24,
                  paddingBottom: 12,
                  borderBottom: `2px solid ${ink}`,
                }}
              >
                <span style={{ flex: 1 }}>Сцена</span>
                <span style={{ width: 130, textAlign: "right" }}>с кадра</span>
                <span style={{ width: 130, textAlign: "right" }}>по кадр</span>
              </div>
            </div>
            <div
              style={{
                position: "absolute",
                left: 40,
                right: 40,
                top: TABLE_TOP,
                fontFamily: cyrillicGroteskFont,
                fontSize: 36,
                fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {scenes.slice(0, 10).map((scene) => (
                <div
                  key={scene.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: ROW_HEIGHT,
                    borderBottom: "1px solid rgba(14,13,11,0.18)",
                  }}
                >
                  <span style={{ flex: 1 }}>{NAMES[scene.id]}</span>
                  <span style={{ width: 130, textAlign: "right" }}>{scene.from}</span>
                  <span style={{ width: 130, textAlign: "right" }}>{scene.to}</span>
                </div>
              ))}
              <div style={{ textAlign: "right", fontWeight: 700, paddingTop: 12 }}>Итого {totalFrames} кадра</div>
            </div>
            <svg
              width={1180}
              height={90}
              viewBox="0 0 1180 90"
              style={{ position: "absolute", left: 0, top: TABLE_TOP + ROW_HEIGHT * CIRCLED - 8, overflow: "visible" }}
            >
              <path
                d={PENCIL}
                fill="none"
                stroke={signal}
                strokeWidth={6}
                strokeLinecap="round"
                strokeDasharray={pencil.strokeDasharray}
                strokeDashoffset={pencil.strokeDashoffset}
              />
            </svg>
          </Sheet>
        </DepthLayer>
        <DepthLayer depth={-620} overscan={200}>
          <div
            style={{
              position: "absolute",
              left: 1280,
              top: 1040,
              width: 1300,
              height: 160,
              backgroundColor: paper,
              transform: "rotate(-9deg)",
              boxShadow: "0 30px 60px rgba(0,0,0,0.5)",
            }}
          >
            <div style={{ display: "flex", height: 60 }}>
              {Array.from({ length: 40 }, (_, i) => (
                <div key={i} style={{ width: 32, borderLeft: `3px solid ${ink}`, height: i % 5 === 0 ? 60 : 30 }} />
              ))}
            </div>
          </div>
        </DepthLayer>
      </Camera>
      <FilmGrain seed="shot-list" opacity={0.1} />
    </AbsoluteFill>
  );
};
