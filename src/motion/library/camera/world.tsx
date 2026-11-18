import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { DepthLayer } from "../../camera";
import { DEMO } from "../transitions/demo";

/** Preview world for the camera items: four planes at real depths, so parallax, scale and focus all read. */

const BARS = [0.3, 0.46, 0.4, 0.62, 0.55, 0.78, 0.7, 0.94];

const Card: React.FC<{ w: number; u: number; accent: string; label: string; value: string }> = ({
  w,
  u,
  accent,
  label,
  value,
}) => (
  <div
    style={{
      width: w,
      height: w * 0.62,
      borderRadius: 34 * u,
      background: "linear-gradient(160deg, #1F2435, #141824)",
      border: "1px solid rgba(255,255,255,0.13)",
      boxShadow: `0 ${50 * u}px ${140 * u}px rgba(0,0,0,0.6)`,
      padding: 44 * u,
      boxSizing: "border-box",
      position: "relative",
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontFamily: primaryFont,
        fontSize: 26 * u,
        color: DEMO.muted,
      }}
    >
      <span>{label}</span>
      <span style={{ color: DEMO.chalk, fontWeight: 700 }}>{value}</span>
    </div>
    <div
      style={{
        position: "absolute",
        left: 44 * u,
        right: 44 * u,
        bottom: 44 * u,
        height: w * 0.34,
        display: "flex",
        alignItems: "flex-end",
        gap: 16 * u,
      }}
    >
      {BARS.map((bar, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${bar * 100}%`,
            borderRadius: 10 * u,
            background: i === BARS.length - 1 ? accent : "rgba(242,240,234,0.15)",
          }}
        />
      ))}
    </div>
  </div>
);

const Chip: React.FC<{ u: number; children: React.ReactNode; accent?: boolean }> = ({ u, children, accent }) => (
  <div
    style={{
      fontFamily: primaryFont,
      fontWeight: 600,
      fontSize: 34 * u,
      padding: `${20 * u}px ${34 * u}px`,
      borderRadius: 999,
      background: accent ? DEMO.indigo : "rgba(242,240,234,0.12)",
      color: DEMO.chalk,
      border: "1px solid rgba(255,255,255,0.16)",
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </div>
);

export const DemoWorld: React.FC<{ headline?: string }> = ({ headline = "Ship in hours." }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const vertical = height > width;
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", inset: "-20%", backgroundColor: DEMO.night }} />
      <DepthLayer depth={900} overscan={1100}>
        <AbsoluteFill
          style={{ background: "radial-gradient(45% 45% at 50% 50%, rgba(110,107,255,0.4), rgba(10,12,18,0) 75%)" }}
        />
        <AbsoluteFill
          style={{
            backgroundImage: `linear-gradient(${DEMO.nightLine} 1px, transparent 1px), linear-gradient(90deg, ${DEMO.nightLine} 1px, transparent 1px)`,
            backgroundSize: `${120 * u}px ${120 * u}px`,
          }}
        />
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div
            style={{
              fontFamily: displayFont,
              fontWeight: 700,
              fontSize: (vertical ? 300 : 340) * u,
              letterSpacing: -10 * u,
              color: "rgba(242,240,234,0.9)",
              transform: `translateY(${(vertical ? -700 : -560) * u}px)`,
              whiteSpace: vertical ? "normal" : "nowrap",
              textAlign: "center",
              lineHeight: 0.9,
              width: vertical ? 1500 * u : undefined,
            }}
          >
            {headline}
          </div>
        </AbsoluteFill>
      </DepthLayer>
      <DepthLayer depth={320}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div
            style={{
              transform: `translate(${(vertical ? -250 : -620) * u}px, ${(vertical ? -330 : 120) * u}px) rotate(-4deg)`,
              opacity: 0.85,
            }}
          >
            <Card w={560 * u} u={u} accent="#8F8CFF" label="Rollbacks" value="0" />
          </div>
        </AbsoluteFill>
      </DepthLayer>
      <DepthLayer depth={0}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div style={{ transform: `translate(${(vertical ? 0 : 180) * u}px, ${(vertical ? 220 : 60) * u}px)` }}>
            <Card w={(vertical ? 860 : 780) * u} u={u} accent={DEMO.indigo} label="Deploy time" value="−92%" />
          </div>
        </AbsoluteFill>
      </DepthLayer>
      <DepthLayer depth={-380}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div
            style={{
              position: "absolute",
              transform: `translate(${(vertical ? 260 : 720) * u}px, ${(vertical ? -120 : -330) * u}px)`,
            }}
          >
            <Chip u={u} accent>
              Live
            </Chip>
          </div>
          <div
            style={{
              position: "absolute",
              transform: `translate(${(vertical ? -300 : -760) * u}px, ${(vertical ? 760 : 380) * u}px)`,
            }}
          >
            <Chip u={u}>12 regions</Chip>
          </div>
        </AbsoluteFill>
      </DepthLayer>
    </AbsoluteFill>
  );
};
