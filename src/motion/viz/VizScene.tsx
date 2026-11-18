import { VizEvents } from "./VizEvents";
import { FittedLine } from "../text";
import { vizScreenTransform, vizProjection, vizCameraState, vizElementState } from "./state";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { z } from "zod";
import { Video } from "@remotion/media";
import { staticFile, Img } from "remotion";
import { VizThree } from "./VizThree";
import { VizBindingSchema, VizPlanSchema } from "../../types/viz";

export const vizSceneSchema = z.object({
  plans: z.array(VizPlanSchema).min(1),
  ground: z.string().default("transparent"),
  plateSrc: z.string().optional(),
  plateFrames: z.record(z.string().regex(/^\d+$/), z.string()).optional(),
  vizBinding: VizBindingSchema.optional(),
});
export type VizSceneProps = z.infer<typeof vizSceneSchema>;
export const VizScene: React.FC<VizSceneProps> = ({ plans, ground, plateSrc, plateFrames }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const plan = plans.find((p) => p.width === width && p.height === height);
  if (!plan) throw new Error(`Visualisation has no compiled plan for ${width}×${height}`);
  const camera = vizCameraState(plan, frame);
  const [a, b, c, d] = vizScreenTransform(plan, frame);
  const determinant = a * d - b * c;
  const progress = interpolate(frame, [0, Math.min(90, plan.spec.durationFrames - 30)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ backgroundColor: ground === "transparent" ? "transparent" : plan.spec.theme.background }}>
      {plateFrames ? (
        <Img
          src={staticFile(
            plateFrames[String(frame)] ??
              (() => {
                throw new Error("Missing Blender plate frame");
              })(),
          )}
          style={{ width, height }}
        />
      ) : plateSrc ? (
        <Video src={staticFile(plateSrc)} muted style={{ width, height }} />
      ) : plan.spec.recipe.endsWith("-3d") ? (
        <VizThree plan={plan} />
      ) : null}
      <svg
        style={{ position: "absolute", inset: 0, zIndex: 1 }}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <text x={110} y={110} fill={plan.spec.theme.ink} fontSize={48} fontFamily="sans-serif">
          {plan.spec.title}
        </text>
        <g transform={`matrix(${vizScreenTransform(plan, frame).join(",")})`}>
          {plan.primitives.map((p) => {
            const { opacity, fill, progress: elementProgress } = vizElementState(plan, p, frame);
            if (p.kind === "text")
              return (
                <FittedLine
                  key={p.id}
                  text={p.text ?? ""}
                  withinWidth={p.width ?? 180}
                  fontFamily="sans-serif"
                  maxFontSize={26}
                >
                  {(size) => {
                    if (size < 18) throw new Error(`Label ${p.id} is too small; shorten it or divide the scene`);
                    return (
                      <text
                        transform={
                          plan.spec.recipe.endsWith("-3d")
                            ? `translate(${p.x},${p.y}) matrix(${d / determinant},${-b / determinant},${-c / determinant},${a / determinant},0,0)`
                            : undefined
                        }
                        x={plan.spec.recipe.endsWith("-3d") ? 0 : p.x}
                        y={plan.spec.recipe.endsWith("-3d") ? 0 : p.y}
                        fill={fill}
                        opacity={opacity}
                        fontSize={size}
                        textAnchor="middle"
                        fontFamily="sans-serif"
                      >
                        {p.text}
                      </text>
                    );
                  }}
                </FittedLine>
              );
            if (plan.spec.recipe.endsWith("-3d")) return null;
            if (p.kind === "circle")
              return <circle key={p.id} cx={p.x} cy={p.y} r={p.radius} fill={fill} opacity={opacity} />;
            if (p.kind === "rect")
              return (
                <rect
                  key={p.id}
                  x={p.x}
                  y={p.y}
                  width={p.width}
                  height={p.height}
                  fill={fill}
                  opacity={opacity}
                  rx={4}
                />
              );
            const closed = p.d?.endsWith("Z");
            return (
              <path
                key={p.id}
                d={p.d}
                transform={`translate(${p.x},${p.y})`}
                fill={closed ? fill : "none"}
                stroke={fill}
                strokeWidth={p.strokeWidth ?? (closed ? 1 : 5)}
                opacity={opacity}
                pathLength={1}
                strokeDasharray={closed ? undefined : 1}
                strokeDashoffset={closed ? undefined : 1 - elementProgress}
              />
            );
          })}
        </g>
        <VizEvents plan={plan} frame={frame} />
      </svg>
    </AbsoluteFill>
  );
};
