import type React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";

export const studioInk = "#172420";
export const studioPaper = "#E9EDDF";
export const studioAccent = "#CDEB84";

export const ProductionStage: React.FC<{
  title: string;
  index: string;
  children: React.ReactNode;
  ground?: string;
}> = ({ title, index, children, ground = studioInk }) => {
  const { width } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{ background: ground, color: studioPaper, fontFamily: "Arial, sans-serif", overflow: "hidden" }}
    >
      <div
        style={{
          position: "absolute",
          top: "9%",
          left: "8%",
          right: "8%",
          borderTop: "1px solid #C3D4BB80",
          display: "flex",
          justifyContent: "space-between",
          paddingTop: width * 0.011,
          fontSize: width * 0.017,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
        }}
      >
        <span>{title}</span>
        <span style={{ color: studioAccent }}>{index}</span>
      </div>
      <div style={{ position: "absolute", inset: "20% 8% 11%" }}>{children}</div>
    </AbsoluteFill>
  );
};

export const ProductionArt: React.FC<{
  title: string;
  paper?: string;
  ink?: string;
  radius?: number;
  titleScale?: number;
  turn?: number;
}> = ({ title, paper = studioAccent, ink = studioInk, radius = 22, titleScale = 1, turn = -16 }) => (
  <svg width="100%" height="100%" viewBox="0 0 800 470" preserveAspectRatio="none" aria-hidden>
    <rect width="800" height="470" rx={radius} fill={paper} />
    {Array.from({ length: 15 }, (_, i) => (
      <ellipse
        key={i}
        cx={497 + i * 5}
        cy={204 - i * 2}
        rx={248 - i * 12}
        ry={129 - i * 5.5}
        transform={`rotate(${turn} 526 220)`}
        fill="none"
        stroke={ink}
        strokeWidth={i % 5 === 0 ? 2.4 : 1.1}
      />
    ))}
    <path d="M42 118V46h67M684 417h73v-65" fill="none" stroke={ink} strokeWidth="2" opacity="0.52" />
    <text
      x="56"
      y="412"
      fill={ink}
      fontFamily="Georgia, serif"
      fontSize={Math.min(88, 790 / Math.max(1, title.length)) * titleScale}
      letterSpacing="-2"
    >
      {title}
    </text>
  </svg>
);
