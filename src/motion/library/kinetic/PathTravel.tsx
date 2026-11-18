import React from "react";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { gsap, toFrame, useFontsReady, useGsapTimeline } from "../../gsap";
import type { Cue } from "../types";
import { Stage, useSafeArea } from "../typography/Stage";

export const pathTravelSchema = z.object({
  /** Labels of the stops, in travel order; they sit at equal lengths along the path. */
  stops: z.array(z.string()).min(2),
  /** Path in a 1600 × 800 box for landscape and square frames. */
  path: z.string(),
  /** Path in a 800 × 1400 box for vertical frames. */
  verticalPath: z.string(),
  color: z.string(),
  muted: z.string(),
  accent: z.string(),
  background: z.string(),
  at: z.number().nonnegative(),
  /** Seconds to travel between neighbouring stops. */
  leg: z.number().positive(),
  /** Seconds the marker rests on each stop. */
  rest: z.number().nonnegative(),
});

export type PathTravelProps = z.infer<typeof pathTravelSchema>;

export const pathTravelPlan = (props: PathTravelProps) => {
  const start = props.at / 30;
  const arrivals = props.stops.map(
    (_, index) => start + 0.35 + index * (props.leg + props.rest) - (index === 0 ? 0 : props.rest),
  );
  return {
    start,
    arrivals,
    departures: arrivals.slice(0, -1).map((time, index) => (index === 0 ? time : time + props.rest)),
  };
};

export const pathTravelCues = (props: PathTravelProps): Cue[] => {
  const plan = pathTravelPlan(props);
  const last = plan.arrivals.length - 1;
  return [
    { frame: toFrame(plan.start), kind: "reveal", sfx: "pop", weight: "support", label: "start" },
    ...plan.arrivals.slice(1).map((time, index): Cue => ({
      frame: toFrame(time),
      kind: index + 1 === last ? "land" : "hit",
      sfx: index + 1 === last ? "chime" : "tick",
      weight: index + 1 === last ? "hero" : "support",
      label: `stop-${index + 2}`,
    })),
  ];
};

/**
 * MotionPath journey: a marker travels a curved route that draws itself behind it (DrawSVG in step with the travel),
 * eases into each stop, where the node pops and its label rises; the last stop lands in the accent colour. For flows,
 * pipelines, onboarding steps and "from A to B" stories.
 */
export const PathTravel: React.FC<PathTravelProps> = (props) => {
  const { stops, path, verticalPath, color, muted, accent, background } = props;
  const safe = useSafeArea();
  const ready = useFontsReady([`600 40px ${primaryFont}`]);
  const plan = pathTravelPlan(props);
  const [vw, vh] = safe.vertical ? [800, 1400] : [1600, 800];
  const scale = Math.min((safe.width * (safe.vertical ? 1 : 0.92)) / vw, (safe.height * 0.9) / vh);
  const label = safe.vertical ? 64 : 58;
  const scope = useGsapTimeline<HTMLDivElement>(
    ({ timeline, selector }) => {
      const [route] = selector("[data-route]") as unknown as SVGPathElement[];
      const [trail] = selector("[data-trail]") as unknown as SVGPathElement[];
      const [marker] = selector("[data-marker]");
      const nodes = selector("[data-node]");
      const names = selector("[data-name]") as unknown as SVGTextElement[];
      const total = route.getTotalLength();
      const share = (index: number) => index / (stops.length - 1);
      // Static layout, measured once from the route: zero-duration sets are allowed outside the timeline.
      nodes.forEach((node, index) => {
        const point = route.getPointAtLength(total * share(index));
        gsap.set(node, { attr: { cx: point.x, cy: point.y } });
        // Vertical routes run up the frame, so labels sit beside the node, on the side away from the curve.
        if (safe.vertical) {
          const right = point.x < vw / 2;
          gsap.set(names[index], {
            attr: {
              x: point.x + (right ? 1 : -1) * label * (index === stops.length - 1 ? 1.1 : 0.8),
              y: point.y + label * 0.35,
              "text-anchor": right ? "start" : "end",
            },
          });
        } else gsap.set(names[index], { attr: { x: point.x, y: point.y - label * 1.1 } });
      });
      timeline.addLabel("start", plan.start);
      timeline.fromTo(
        marker,
        { scale: 0, transformOrigin: "50% 50%" },
        { scale: 1, duration: 0.4, ease: "back.out(2.4)" },
        "start",
      );
      timeline.fromTo(
        nodes[0],
        { scale: 0, transformOrigin: "50% 50%" },
        { scale: 1, duration: 0.4, ease: "back.out(2.4)" },
        "start",
      );
      timeline.fromTo(
        names[0],
        { opacity: 0, y: 16 },
        { opacity: 1, y: 0, duration: 0.5, ease: "kinetic.out" },
        "start",
      );
      timeline.set(marker, { motionPath: { path: route, align: route, alignOrigin: [0.5, 0.5], start: 0, end: 0 } }, 0);
      plan.departures.forEach((departure, index) => {
        const arrive = plan.arrivals[index + 1];
        timeline.fromTo(
          marker,
          {
            motionPath: { path: route, align: route, alignOrigin: [0.5, 0.5], start: share(index), end: share(index) },
          },
          {
            motionPath: {
              path: route,
              align: route,
              alignOrigin: [0.5, 0.5],
              start: share(index),
              end: share(index + 1),
            },
            duration: props.leg,
            ease: "kinetic.inOut",
            immediateRender: false,
          },
          departure,
        );
        timeline.fromTo(
          trail,
          { drawSVG: `0% ${share(index) * 100}%` },
          {
            drawSVG: `0% ${share(index + 1) * 100}%`,
            duration: props.leg,
            ease: "kinetic.inOut",
            immediateRender: false,
          },
          departure,
        );
        timeline.addLabel(`stop-${index + 2}`, arrive);
        timeline.fromTo(
          nodes[index + 1],
          { scale: 0, transformOrigin: "50% 50%" },
          { scale: 1, duration: 0.45, ease: "back.out(2.6)", immediateRender: false },
          arrive - 0.06,
        );
        timeline.fromTo(
          names[index + 1],
          { opacity: 0, y: 16 },
          { opacity: 1, y: 0, duration: 0.5, ease: "kinetic.out", immediateRender: false },
          arrive,
        );
      });
      timeline.fromTo(
        marker,
        { scale: 1 },
        { scale: 1.35, duration: 0.5, ease: "kinetic.snap", immediateRender: false },
        plan.arrivals.at(-1) ?? 0,
      );
      gsap.set(trail, { drawSVG: "0% 0%" });
      nodes.slice(1).forEach((node) => gsap.set(node, { scale: 0, transformOrigin: "50% 50%" }));
      names.slice(1).forEach((name) => gsap.set(name, { opacity: 0 }));
    },
    { dependencies: [ready, JSON.stringify(props), safe.vertical] },
  );
  if (!ready) return <Stage background={background}>{null}</Stage>;
  const d = safe.vertical ? verticalPath : path;
  return (
    <Stage background={background}>
      <div
        ref={scope}
        style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <svg viewBox={`0 0 ${vw} ${vh}`} width={vw * scale} height={vh * scale} style={{ overflow: "visible" }}>
          <path
            data-route
            d={d}
            fill="none"
            stroke={muted}
            strokeOpacity={0.35}
            strokeWidth={5}
            strokeDasharray="2 18"
            strokeLinecap="round"
          />
          <path data-trail d={d} fill="none" stroke={color} strokeWidth={9} strokeLinecap="round" />
          {stops.map((stop, index) => (
            <React.Fragment key={index}>
              <circle
                data-node
                r={index === stops.length - 1 ? 26 : 18}
                fill={background}
                stroke={index === stops.length - 1 ? accent : color}
                strokeWidth={8}
              />
              <text
                data-name
                textAnchor="middle"
                style={{ fontFamily: primaryFont, fontWeight: 650, fontSize: label, letterSpacing: "-0.03em" }}
                fill={index === stops.length - 1 ? accent : color}
              >
                {stop}
              </text>
            </React.Fragment>
          ))}
          <circle data-marker r={22} fill={accent} />
        </svg>
      </div>
    </Stage>
  );
};

export const pathTravelDefaults: PathTravelProps = {
  stops: ["Idea", "Script", "Cut", "Shipped"],
  path: "M120,560 C320,560 360,300 560,300 C760,300 760,560 980,560 C1200,560 1240,260 1480,240",
  verticalPath: "M160,1240 C160,1000 640,1060 640,820 C640,600 160,660 160,440 C160,240 520,220 640,160",
  color: "#111111",
  muted: "#6b6f76",
  accent: "#3d5afe",
  background: "#f3f1ec",
  at: 6,
  leg: 0.75,
  rest: 0.25,
};
