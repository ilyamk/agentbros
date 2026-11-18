import React from "react";
import { Img, staticFile, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { primaryFont } from "../../lib/fonts";
import { typography, spacing } from "../../lib/design-tokens";
import type { TemplateInstance } from "../../types/templates";
type Pack = Extract<
  TemplateInstance,
  {
    id: "scene.worked-example" | "scene.product-walkthrough" | "scene.editorial-evidence";
  }
>;
/** One argument per scene. Copy wraps without silently shrinking or clipping. */
export const StylePackScene: React.FC<{
  instance: Pack;
  accentColor: string;
}> = ({ instance, accentColor }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const fmt = height > width ? "vertical" : height < width ? "landscape" : "square";
  const fade = (start: number) =>
    interpolate(frame, [start, start + 12], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const body: React.CSSProperties = {
    ...typography.subtext[fmt],
    overflowWrap: "anywhere",
  };
  const gap = spacing.headlineGap;
  return (
    <div
      style={{
        width: "100%",
        maxWidth: "100%",
        fontFamily: primaryFont,
        display: "flex",
        flexDirection: "column",
        gap,
      }}
    >
      <div
        data-avc-text-role="media-headline"
        style={{
          ...typography.bigTitle[fmt],
          opacity: fade(0),
          overflowWrap: "anywhere",
        }}
      >
        {instance.props.headline}
      </div>
      {instance.id === "scene.worked-example" && (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap,
            }}
          >
            {instance.props.steps.map((step, index) => (
              <div
                key={index}
                style={{
                  opacity: fade(12 + index * 12),
                  display: "flex",
                  flexDirection: "column",
                  gap: gap / 2,
                }}
              >
                <div
                  style={{
                    ...typography.feature[fmt],
                    color: accentColor,
                    overflowWrap: "anywhere",
                  }}
                >
                  {index + 1}. {step.label}
                </div>
                <div style={body}>{step.detail}</div>
              </div>
            ))}
          </div>
          <div
            style={{
              ...body,
              color: accentColor,
              opacity: fade(12 + instance.props.steps.length * 12),
            }}
          >
            {instance.props.result}
          </div>
        </>
      )}
      {instance.id === "scene.product-walkthrough" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: fmt === "landscape" ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
            gap,
            alignItems: "center",
            opacity: fade(12),
          }}
        >
          <Img
            src={
              /^https?:/.test(instance.props.imageUrl) ? instance.props.imageUrl : staticFile(instance.props.imageUrl)
            }
            style={{
              width: "100%",
              height: (height - spacing.safeTop[fmt] - spacing.safeBottom[fmt]) * 0.35,
              objectFit: "contain",
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap,
              minWidth: 0,
            }}
          >
            <div style={body}>{instance.props.action}</div>
            <div
              style={{
                ...body,
                color: accentColor,
                opacity: fade(24),
              }}
            >
              {instance.props.outcome}
            </div>
          </div>
        </div>
      )}
      {instance.id === "scene.editorial-evidence" && (
        <>
          <div
            style={{
              ...typography.feature[fmt],
              opacity: fade(12),
              overflowWrap: "anywhere",
            }}
          >
            {instance.props.statement}
          </div>
          <div
            style={{
              ...typography.small[fmt],
              opacity: fade(12),
              color: accentColor,
              overflowWrap: "anywhere",
            }}
          >
            {instance.props.sourceLabel}
          </div>
          {instance.props.interpretation && (
            <div
              style={{
                ...body,
                opacity: fade(24),
              }}
            >
              {instance.props.interpretation}
            </div>
          )}
        </>
      )}
    </div>
  );
};
