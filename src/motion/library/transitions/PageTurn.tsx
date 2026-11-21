import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { useFittedFontSize } from "../../text";
import { progress } from "../../timing";
import type { Cue } from "../types";

export const pageTurnSchema = z
  .object({
    seamFrame: z.number().int().nonnegative(),
    moveFrames: z.number().int().min(12),
    paper: z.string(),
    diagonal: z.number().min(0).max(0.22),
  })
  .refine((p) => p.seamFrame >= Math.floor(p.moveFrames / 2), {
    path: ["seamFrame"],
    message: "Leave room for the first half of the turn before the seam.",
  });

export type PageTurnProps = z.infer<typeof pageTurnSchema>;

export const pageTurnDefaults = {
  seamFrame: 48,
  moveFrames: 30,
  paper: "#F1EAD5",
  diagonal: 0.11,
} satisfies PageTurnProps;

export const pageTurnCues = (p: PageTurnProps): Cue[] => [
  { frame: p.seamFrame, kind: "cut", sfx: "whoosh", weight: "hero", label: "Paper turn seam" },
];

export const pageTurnPose = (frame: number, p: PageTurnProps) => {
  const start = p.seamFrame - Math.floor(p.moveFrames / 2);
  const middle = frame <= p.seamFrame;
  const fraction = middle
    ? progress(frame, start, p.seamFrame - start, "quadIn") * 0.5
    : 1 - 0.5 * (1 - progress(frame, p.seamFrame, start + p.moveFrames - p.seamFrame, "linear")) ** 2;
  const curl = Math.sin(Math.PI * fraction);
  return {
    fraction,
    fold: 1 - fraction,
    curl,
    skew: p.diagonal * curl,
    foldWidth: 0.175 * curl,
  };
};

export const PageTurn: React.FC<PageTurnProps & { from: React.ReactNode; to: React.ReactNode }> = ({
  from,
  to,
  ...props
}) => {
  const frame = useCurrentFrame();
  const curlId = React.useId();
  const { fraction, fold, curl, skew, foldWidth } = pageTurnPose(frame, props);
  if (fraction === 0) return <AbsoluteFill>{from}</AbsoluteFill>;
  if (fraction === 1) return <AbsoluteFill>{to}</AbsoluteFill>;
  const percent = (value: number) => `${value * 100}%`;
  const top = percent(fold + skew);
  const bottom = percent(fold - skew);
  const edge = [
    `${(fold + skew - foldWidth) * 1000},0`,
    `${(fold + skew) * 1000},0`,
    `${(fold - skew) * 1000},1000`,
    `${(fold - skew - foldWidth) * 1000},1000`,
  ].join(" ");
  const band = (left: number, right: number) =>
    `polygon(${percent(fold + skew + left)} 0%, ${percent(fold + skew + right)} 0%, ${percent(fold - skew + right)} 100%, ${percent(fold - skew + left)} 100%)`;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill style={{ isolation: "isolate" }}>{to}</AbsoluteFill>
      <AbsoluteFill
        aria-hidden
        style={{
          clipPath: band(0, 0.052 * curl),
          background: "#1D2519",
          opacity: 0.18 * curl,
        }}
      />
      <AbsoluteFill style={{ clipPath: `polygon(0% 0%, ${top} 0%, ${bottom} 100%, 0% 100%)` }}>{from}</AbsoluteFill>
      <svg
        aria-hidden
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      >
        <defs>
          <linearGradient
            id={curlId}
            gradientUnits="userSpaceOnUse"
            x1={(fold - foldWidth) * 1000}
            x2={fold * 1000}
            y1={0}
            y2={0}
            gradientTransform={`matrix(1 0 ${-2 * skew} 1 ${skew * 1000} 0)`}
          >
            <stop offset="0" stopColor="#413321" stopOpacity="0.24" />
            <stop offset="0.48" stopColor="#FFFDF3" stopOpacity="0.42" />
            <stop offset="0.76" stopColor="#FFFDF3" stopOpacity="0.06" />
            <stop offset="1" stopColor="#413321" stopOpacity="0.42" />
          </linearGradient>
        </defs>
        <polygon points={edge} fill={props.paper} />
        <polygon points={edge} fill={`url(#${curlId})`} />
      </svg>
    </AbsoluteFill>
  );
};

export const EditorialPage: React.FC<{
  title: string;
  label: string;
  paper: string;
  ink: string;
  reverse?: boolean;
}> = ({ title, label, paper, ink, reverse = false }) => {
  const { width, height } = useVideoConfig();
  const span = Math.min(width, height);
  const titleSize = useFittedFontSize({
    text: title,
    withinWidth: width - span * 0.2,
    fontFamily: "Georgia, serif",
    letterSpacing: "-0.06em",
  });
  return (
    <AbsoluteFill
      style={{
        background: paper,
        color: ink,
        padding: `${Math.max(span * 0.1, height * 0.12)}px ${span * 0.1}px ${Math.max(span * 0.1, height * 0.15)}px`,
        justifyContent: "space-between",
      }}
    >
      <div
        style={{
          borderTop: `2px solid ${ink}`,
          paddingTop: span * 0.023,
          font: `bold ${span * 0.028}px Arial, sans-serif`,
          letterSpacing: "0.11em",
        }}
      >
        {label}
      </div>
      <svg
        viewBox="0 0 610 530"
        style={{
          position: "absolute",
          width: span * 0.78,
          height: span * 0.68,
          left: "50%",
          top: "49%",
          transform: `translate(-50%, -50%) rotate(${reverse ? 34 : -21}deg)`,
        }}
      >
        {Array.from({ length: 19 }, (_, i) => (
          <ellipse
            key={i}
            cx={285 + i * 2.2}
            cy={268 - i * 2}
            rx={278 - i * 10}
            ry={160 - i * 5.8}
            stroke={ink}
            fill="none"
            strokeWidth={i % 6 === 0 ? 2.6 : 1.1}
          />
        ))}
      </svg>
      <div
        style={{
          font: `${Math.min(span * 0.155, titleSize ?? 0)}px/0.92 Georgia, serif`,
          letterSpacing: "-0.06em",
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};

export const PageTurnPreview: React.FC<PageTurnProps> = (p) => (
  <PageTurn
    {...p}
    from={<EditorialPage label="FIELD NOTES" title="Surface" paper="#D8E5BA" ink="#22382A" />}
    to={<EditorialPage label="FIELD NOTES" title="Light" paper="#EADFC2" ink="#46351D" reverse />}
  />
);
