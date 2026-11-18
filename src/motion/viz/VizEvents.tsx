import React from "react";
import { getLength, getPointAtLength } from "@remotion/paths";
import type { VizPlan } from "../../types/viz";
import { vizScreenTransform } from "./state";
import { FittedLine } from "../text";
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const VizEvents: React.FC<{ plan: VizPlan; frame: number }> = ({ plan, frame }) => {
  const [a, b, c, d, e, f] = vizScreenTransform(plan, frame);
  const project = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f });
  return (
    <>
      {plan.spec.events.map((event, index) => {
        if (frame < event.frame || !["annotate", "travel"].includes(event.action)) return null;
        const target =
          plan.primitives.find((p) => p.id === event.target) ?? plan.primitives.find((p) => p.datumId === event.target);
        if (!target) return null;
        if (event.action === "travel") {
          if (!target.d) return null;
          const length = getLength(target.d);
          const point = getPointAtLength(target.d, length * clamp((frame - event.frame) / event.duration));
          if (!point) return null;
          const position = project(target.x + point.x, target.y + point.y);
          return (
            <circle
              key={index}
              cx={position.x}
              cy={position.y}
              r={10}
              fill={plan.spec.theme.ink}
              stroke={plan.spec.theme.accent}
              strokeWidth={3}
            />
          );
        }
        if (frame >= event.frame + event.duration) return null;
        const position = project(target.x + (target.kind === "rect" ? (target.width ?? 0) / 2 : 0), target.y);
        const x = Math.max(20, Math.min(plan.width - 320, position.x + 20)),
          y = Math.max(140, Math.min(plan.height - 100, position.y - 100));
        return (
          <g key={index}>
            <line x1={position.x} y1={position.y} x2={x} y2={y + 40} stroke={plan.spec.theme.ink} strokeWidth={2} />
            <rect
              x={x}
              y={y}
              width={300}
              height={70}
              rx={8}
              fill={plan.spec.theme.background === "transparent" ? "#10121a" : plan.spec.theme.background}
              stroke={plan.spec.theme.ink}
            />
            <FittedLine text={event.text!} withinWidth={280} fontFamily="sans-serif" maxFontSize={24}>
              {(size) => {
                if (size < 18) throw new Error("Annotation is too long for its reading card");
                return (
                  <text x={x + 150} y={y + 44} textAnchor="middle" fontSize={size} fill={plan.spec.theme.ink}>
                    {event.text}
                  </text>
                );
              }}
            </FittedLine>
          </g>
        );
      })}
    </>
  );
};
