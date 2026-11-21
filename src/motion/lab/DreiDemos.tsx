import React from "react";
import { AbsoluteFill, Series, useCurrentFrame, useVideoConfig } from "remotion";
import { ExhibitAssembly } from "../library/three/InstancedAssembly";
import { ExhibitModelShot } from "../library/three/ModelShot";
import { airPath, cellAssembly, projectorStage, releaseBattery } from "../library/three/shot-techniques";
import { assemblyCues, type ShotCamera } from "../library/three/shot-plan";
import { easeInOut, ramp } from "../library/three/shared";
import { DreiOpticalStudy } from "./DreiOpticalStudy";

const numberStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.13em",
  textTransform: "uppercase",
};

const FrameText: React.FC<{ children: React.ReactNode; colour: string }> = ({ children, colour }) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      color: colour,
      fontFamily: '"Helvetica Neue", system-ui, sans-serif',
    }}
  >
    {children}
  </AbsoluteFill>
);

const Identifier: React.FC<{ children: React.ReactNode; dark?: boolean }> = ({ children, dark }) => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return (
    <div
      style={{
        ...numberStyle,
        position: "absolute",
        left: portrait ? 86 : 99,
        bottom: portrait ? 410 : 80,
        color: dark ? "#d5e9e5" : "#393a35",
        fontSize: portrait ? 24 : 20,
      }}
    >
      {children}
    </div>
  );
};

export const DreiProjector: React.FC = () => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const camera: ShotCamera = {
    points: [
      [-0.43, 0.31, 1.02],
      [-0.15, 0.25, 1.01],
      [0.31, 0.24, 0.92],
    ],
    target: portrait ? [0, 0.29, 0] : [-0.78, 0.05, 0],
    targetEnd: portrait ? [0, 0.2, 0] : [-0.72, 0.08, 0],
    startFrame: 0,
    endFrame: 135,
  };
  return (
    <AbsoluteFill>
      <ExhibitModelShot {...projectorStage} fill={portrait ? 0.82 : 0.69} camera={camera} look="warm" />
      <FrameText colour="#262522">
        <div style={{ position: "absolute", left: portrait ? 82 : 102, top: portrait ? 244 : 286 }}>
          <div style={{ ...numberStyle, fontSize: 23, marginBottom: 25 }}>Optical instrument / 01</div>
          <div style={{ fontWeight: 690, fontSize: portrait ? 124 : 130, lineHeight: 0.88, letterSpacing: "-0.085em" }}>
            Aperture S
          </div>
          <div style={{ fontWeight: 440, fontSize: portrait ? 32 : 38, marginTop: 29, letterSpacing: "-0.025em" }}>
            A pocket projector concept.
          </div>
        </div>
        <Identifier>Agent Bros. Pictures  /  Design study</Identifier>
      </FrameText>
    </AbsoluteFill>
  );
};

export const DreiConnector: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const camera: ShotCamera = {
    points: [
      [-0.22, 0.19, 1.1],
      [0.07, 0.13, 0.82],
      [0.27, 0.035, portrait ? 0.37 : 0.49],
    ],
    target: [0.04, 0.0, 0],
    targetEnd: [1.0, -0.15, 0.66],
    startFrame: 17,
    endFrame: 104,
  };
  const label = easeInOut(ramp(frame, 96, 116));
  return (
    <AbsoluteFill>
      <ExhibitModelShot {...projectorStage} fill={0.79} camera={camera} look="graphite" />
      <FrameText colour="#fcdfb8">
        <div
          style={{
            ...numberStyle,
            position: "absolute",
            top: portrait ? 238 : 86,
            left: portrait ? 86 : 100,
            fontSize: portrait ? 27 : 23,
            opacity: 1 - ramp(frame, 20, 42),
          }}
        >
          02 / Camera study
        </div>
        <div
          style={{
            position: "absolute",
            left: portrait ? 86 : undefined,
            right: portrait ? undefined : 105,
            bottom: portrait ? 409 : 92,
            opacity: label,
            borderLeft: "2px solid #ffb879",
            paddingLeft: 22,
          }}
        >
          <div style={{ ...numberStyle, fontSize: 19 }}>Recessed connector</div>
          <div style={{ fontSize: portrait ? 68 : 77, fontWeight: 650, letterSpacing: "-0.06em" }}>USB-C</div>
        </div>
      </FrameText>
    </AbsoluteFill>
  );
};

export const DreiLatch: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const camera: ShotCamera = {
    points: [
      [0.34, 0.24, portrait ? 0.86 : 1.08],
      [0.31, 0.25, portrait ? 0.84 : 1.04],
      [0.28, 0.27, portrait ? 0.84 : 1.0],
    ],
    target: portrait ? [0.21, -0.03, 0.22] : [0.05, 0.1, 0.12],
    targetEnd: portrait ? [0.27, -0.04, 0.45] : [0.16, 0.06, 0.3],
    startFrame: 17,
    endFrame: 93,
  };
  const action = frame < 28 ? "01  Locked" : frame < 46 ? "02  Release latch" : "03  Withdraw cartridge";
  const sweep = ramp(frame, 28, 83);
  return (
    <AbsoluteFill>
      <ExhibitModelShot {...releaseBattery} look="warm" camera={camera} fill={0.72} />
      <FrameText colour="#2b2119">
        <div style={{ position: "absolute", top: portrait ? 242 : 95, left: portrait ? 85 : 100 }}>
          <div style={{ ...numberStyle, fontSize: 20, color: "#70472b" }}>03 / Service detail</div>
          <div style={{ fontSize: portrait ? 73 : 82, fontWeight: 650, letterSpacing: "-0.06em" }}>Battery release</div>
        </div>
        <div
          style={{
            position: "absolute",
            left: portrait ? 85 : 100,
            right: portrait ? 155 : undefined,
            bottom: portrait ? 413 : 85,
          }}
        >
          <div style={{ width: portrait ? "100%" : 280, height: 3, background: "#afa191", marginBottom: 17 }}>
            <div style={{ width: `${sweep * 100}%`, height: "100%", background: "#ae572c" }} />
          </div>
          <span style={{ ...numberStyle, fontSize: portrait ? 24 : 20 }}>{action}</span>
        </div>
      </FrameText>
    </AbsoluteFill>
  );
};

const airLabels = ["Intake", "Fan", "Exhaust"] as const;
export const DreiAirPath: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const active = airPath.highlights!.findIndex(({ startFrame, endFrame }) => frame >= startFrame && frame < endFrame);
  const camera: ShotCamera = {
    ...airPath.camera!,
    points: [
      [-0.17, 0.35, 1.12],
      [0.33, 0.38, 1.03],
      [1.03, 0.34, 0.39],
      [0.62, 0.33, -1.02],
      [-0.21, 0.31, -1.11],
    ],
    target: [0, portrait ? 0.25 : 0.06, 0],
  };
  return (
    <AbsoluteFill>
      <ExhibitModelShot {...airPath} look="blueprint" accent="#64f2d4" camera={camera} />
      <FrameText colour="#d8f6ef">
        <div style={{ position: "absolute", left: portrait ? 86 : 100, top: portrait ? 246 : 90 }}>
          <div style={{ ...numberStyle, fontSize: 20, color: "#91cbbf" }}>04 / System diagram</div>
          <div style={{ fontSize: portrait ? 88 : 95, fontWeight: 620, letterSpacing: "-0.07em" }}>Airflow</div>
        </div>
        <div
          style={{
            position: "absolute",
            left: portrait ? 86 : 100,
            bottom: portrait ? 409 : 87,
            display: "flex",
            gap: portrait ? 24 : 38,
            ...numberStyle,
            fontSize: portrait ? 23 : 21,
          }}
        >
          {airLabels.map((label, i) => (
            <span
              key={label}
              style={{
                opacity: i === active ? 1 : 0.5,
                borderTop: `2px solid ${i === active ? "#64f2d4" : "#659d9c"}`,
                paddingTop: 15,
              }}
            >
              {label}
            </span>
          ))}
        </div>
      </FrameText>
    </AbsoluteFill>
  );
};

export const DreiOptics: React.FC<{ control?: boolean }> = ({ control = false }) => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return (
    <AbsoluteFill>
      <DreiOpticalStudy control={control} />
      <FrameText colour="#fff5ec">
        <div style={{ position: "absolute", top: portrait ? 250 : 332, left: portrait ? 86 : 100 }}>
          <div style={{ ...numberStyle, fontSize: 20 }}>05 / Material study</div>
          <div
            style={{
              marginTop: 19,
              fontSize: portrait ? 75 : 91,
              lineHeight: 0.95,
              fontWeight: 650,
              letterSpacing: "-0.069em",
            }}
          >
            Light through
            <br /> glass.
          </div>
        </div>
        <Identifier dark>{control ? "Clear overlay / control" : "Frosted optical glass"}</Identifier>
      </FrameText>
    </AbsoluteFill>
  );
};

export const DreiCells: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const count = assemblyCues(cellAssembly).filter((cue) => frame >= cue).length;
  return (
    <AbsoluteFill>
      <ExhibitAssembly {...cellAssembly} accent="#c77337" />
      <FrameText colour="#3a3026">
        <div style={{ position: "absolute", top: portrait ? 243 : 90, left: portrait ? 86 : 100 }}>
          <div style={{ ...numberStyle, fontSize: 21 }}>06 / Modular assembly</div>
          <div style={{ fontSize: portrait ? 86 : 99, fontWeight: 650, letterSpacing: "-0.07em" }}>24 cells.</div>
        </div>
        <div
          style={{
            position: "absolute",
            left: portrait ? 86 : 100,
            bottom: portrait ? 408 : 86,
            display: "flex",
            alignItems: "center",
            gap: 28,
          }}
        >
          <span style={{ ...numberStyle, fontSize: portrait ? 24 : 21 }}>{count} / 3 modules</span>
          {[1, 2, 3].map((module) => (
            <span
              key={module}
              style={{ width: portrait ? 35 : 58, height: 4, background: count >= module ? "#ad4e1d" : "#a89d8c" }}
            />
          ))}
        </div>
      </FrameText>
    </AbsoluteFill>
  );
};

export const dreiDemos = [
  { id: "DreiProjector", Component: DreiProjector, frames: 150 },
  { id: "DreiConnector", Component: DreiConnector, frames: 150 },
  { id: "DreiLatch", Component: DreiLatch, frames: 120 },
  { id: "DreiAirPath", Component: DreiAirPath, frames: 150 },
  { id: "DreiOptics", Component: DreiOptics, frames: 150 },
  { id: "DreiCells", Component: DreiCells, frames: 180 },
] as const;

export const DreiReel: React.FC = () => (
  <Series>
    {dreiDemos.map(({ id, Component, frames }) => (
      <Series.Sequence key={id} durationInFrames={frames}>
        <Component />
      </Series.Sequence>
    ))}
  </Series>
);
