import React from "react";
import { useCurrentFrame } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { MaskedLine } from "../../text";
import { hierarchy, intentCurves, progress, type HierarchyPlan } from "../../timing";
import type { Cue } from "../types";
import { groteskFace } from "./faces";
import { useSharedFit } from "./fit";
import { EXIT, resolveInk, Stage, useSafeArea } from "./Stage";

export const hierarchyRevealSchema = z.object({
  /** Hero lines, hand-broken; they rise from their masks together and land first. */
  headline: z.array(z.string()).min(1),
  /** One supporting sentence, after a breath. */
  sub: z.string(),
  /** Small facts, staggered in last; empty for none. */
  details: z.array(z.string()),
  /** Frame the hero starts. */
  at: z.number().int().min(0),
  /** Frames from the hero to the sub, and from the sub to the details, at 30 fps. */
  supportGap: z.number().int().min(0).max(40),
  detailGap: z.number().int().min(0).max(40),
  detailStep: z.number().int().min(1).max(12),
  /** Frame everything leaves, detail first; -1 holds. */
  exitAt: z.number().int(),
  /** CSS colour, or "transparent" to lay it over footage. */
  ground: z.string(),
  /** "auto" picks the ink for the ground. */
  ink: z.string(),
  accent: z.string(),
});

export type HierarchyRevealProps = z.infer<typeof hierarchyRevealSchema>;

/** Entry frames by role for these props: hero lines 3 frames apart, one sub, the details. */
export const hierarchyRevealPlan = ({
  headline,
  sub,
  details,
  at,
  supportGap,
  detailGap,
  detailStep,
}: Pick<
  HierarchyRevealProps,
  "headline" | "sub" | "details" | "at" | "supportGap" | "detailGap" | "detailStep"
>): HierarchyPlan =>
  hierarchy(
    { hero: headline.length, support: sub ? 1 : 0, detail: details.length },
    { at, heroStep: 3, supportGap, supportStep: 5, detailGap, detailStep },
  );

const HERO_IN = 20;

export const hierarchyRevealCues = (props: HierarchyRevealProps): Cue[] => {
  const plan = hierarchyRevealPlan(props);
  const cues: Cue[] = [
    { frame: (plan.hero.at(-1) ?? props.at) + 6, kind: "land", sfx: "impact", weight: "hero", label: "headline lands" },
  ];
  if (plan.support[0] !== undefined)
    cues.push({ frame: plan.support[0], kind: "reveal", sfx: "whoosh", weight: "support", label: "sub" });
  plan.detail.forEach((frame) => cues.push({ frame, kind: "reveal", sfx: "tick", weight: "support", label: "detail" }));
  if (props.exitAt >= 0) cues.push({ frame: props.exitAt, kind: "exit", sfx: "whoosh", weight: "support" });
  return cues;
};

/**
 * A frame that builds in reading order: the headline rises from its masks and brakes into place, the sub glides in
 * after a breath, the details snap in on a quick stagger with a hairline in the accent. Left-aligned in the lower
 * two-thirds; leaves in reverse, detail first.
 */
export const HierarchyReveal: React.FC<HierarchyRevealProps> = (props) => {
  const { headline, sub, details, at, exitAt, ground, ink, accent } = props;
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const colour = resolveInk(ink, ground === "transparent" ? "#111111" : ground);
  const maxSize = safe.vertical ? safe.width * 0.22 : safe.height * 0.24;
  const size = useSharedFit(
    headline.map((text) => ({ text, fontFamily: groteskFace, fontWeight: 700, letterSpacing: "-0.045em" })),
    safe.width * (safe.vertical ? 0.96 : 0.7),
    maxSize,
  );
  if (size === null) return <Stage background={ground}>{null}</Stage>;

  const plan = hierarchyRevealPlan(props);
  const leave = (order: number) => (exitAt >= 0 ? 1 - progress(frame, exitAt + order * 2, 12, EXIT) : 1);
  const subSize = Math.max(28, size * 0.24);
  const detailSize = Math.max(22, size * 0.135);
  const support = plan.support[0];
  const subIn = support === undefined ? 0 : progress(frame, support, 18, intentCurves.glide);
  const rule = plan.detail[0] === undefined ? 0 : progress(frame, plan.detail[0] - 2, 16, intentCurves.brake);
  const exitOrder = { detail: 0, sub: 1, hero: 2 };

  return (
    <Stage background={ground}>
      <div
        style={{
          position: "absolute",
          left: safe.side,
          right: safe.side,
          top: safe.top,
          bottom: safe.bottom,
          display: "flex",
          flexDirection: "column",
          justifyContent: safe.vertical ? "center" : "flex-end",
          paddingBottom: safe.vertical ? 0 : safe.height * 0.04,
        }}
      >
        {headline.map((line, index) => (
          <MaskedLine
            key={`${index}-${line}`}
            reveal={progress(frame, plan.hero[index]!, HERO_IN, intentCurves.brake) * leave(exitOrder.hero)}
            lineHeight={0.96}
            style={{
              fontFamily: groteskFace,
              fontWeight: 700,
              fontSize: size,
              letterSpacing: "-0.045em",
              color: colour,
            }}
          >
            {line}
          </MaskedLine>
        ))}
        {sub ? (
          <div
            style={{
              marginTop: size * 0.28,
              maxWidth: safe.vertical ? safe.width : safe.width * 0.56,
              fontFamily: primaryFont,
              fontWeight: 500,
              fontSize: subSize,
              lineHeight: 1.25,
              color: colour,
              opacity: 0.72 * subIn * leave(exitOrder.sub),
              transform: `translateY(${(1 - subIn) * subSize * 0.8}px)`,
            }}
          >
            {sub}
          </div>
        ) : null}
        {details.length > 0 ? (
          <div
            style={{
              marginTop: size * 0.36,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: `${detailSize * 0.6}px ${detailSize * 1.4}px`,
              opacity: leave(exitOrder.detail),
            }}
          >
            <div
              style={{
                width: detailSize * 2.2,
                height: Math.max(2, detailSize * 0.12),
                background: accent,
                transform: `scaleX(${rule})`,
                transformOrigin: "0 50%",
              }}
            />
            {details.map((detail, index) => {
              const p = progress(frame, plan.detail[index]!, 10, intentCurves.snap);
              return (
                <div
                  key={`${index}-${detail}`}
                  style={{
                    fontFamily: primaryFont,
                    fontWeight: 600,
                    fontSize: detailSize,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: colour,
                    opacity: p,
                    transform: `translateX(${(1 - p) * -detailSize}px)`,
                  }}
                >
                  {detail}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Stage>
  );
};

export const HIERARCHY_REVEAL_FRAMES = 105;

export const hierarchyRevealDefaults: HierarchyRevealProps = {
  headline: ["Close incidents", "before the page."],
  sub: "On-call teams resolve alerts three times faster, without leaving the thread they were already in.",
  details: ["SOC 2 Type II", "99.99% uptime", "Slack and Teams"],
  at: 6,
  supportGap: 12,
  detailGap: 10,
  detailStep: 4,
  exitAt: -1,
  ground: "#EFEBE3",
  ink: "auto",
  accent: "#E2552B",
};
