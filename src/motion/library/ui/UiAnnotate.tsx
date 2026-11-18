import React from "react";
import { z } from "zod";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { trackPoint } from "../../timing";
import { geist, geistMono } from "./surface";
import { buildFrames, coordinateLabel, dimensionLabel, holdJitter } from "./ui-plan";

const keySchema = z.object({ at: z.number().int(), x: z.number(), y: z.number() });

export const annotationSchema = z.object({
  /**
   * `box` a thin rectangle with a dimension label; `tag` a point with a coordinate label (and a box when `w`/`h` are set);
   * `handles` a selection box with eight handles and a name badge; `cursor` a pointer with a name tag; `chip` an outline word chip.
   */
  kind: z.enum(["box", "tag", "handles", "cursor", "chip"]),
  /** Where the item's anchor is, keyed by frame (stage shares, 0..1); one key pins it, more track an object. */
  keys: z.array(keySchema).min(1),
  /** Box size as shares of the stage (box, tag, handles). */
  w: z.number().min(0).max(1).optional(),
  h: z.number().min(0).max(1).optional(),
  /** Text: the cursor's or badge's name, the chip's word; for `box` and `tag` empty computes dimensions or coordinates. */
  label: z.string().optional(),
  /** Index of another item to join with a connector line, dots at both ends. */
  connectTo: z.number().int().min(0).optional(),
  /** Overrides the build frame (reading order) for this item. */
  at: z.number().int().optional(),
  /** Colour of this item; absent uses the block's `colour`. */
  colour: z.string().optional(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const uiAnnotateSchema = z.object({
  items: z.array(annotationSchema).min(1),
  /** Frame the build starts; items arrive whole in reading order over `span` frames (airform: 4, steps(1)). */
  buildAt: z.number().int().min(0),
  span: z.number().int().min(0),
  /** Frame everything leaves on one frame; absent keeps it to the end. */
  exitAt: z.number().int().optional(),
  /** Line and label colour; pick the plate's grade (pink on magenta, teal on teal) so the HUD sits in the picture. */
  colour: z.string(),
  /** How the HUD lays over the plate: `normal`, or `screen` / `overlay` to take the plate's colour. */
  blend: z.enum(["normal", "screen", "overlay", "difference"]),
  /** Seeded drift in px, held 2 frames, for boxes that shift slightly frame to frame; 0 holds them still. */
  jitter: z.number().min(0).max(8),
  /** Label size as a share of the frame's short side, the height in landscape (airform: about 0.022; nowakdesign: about 0.03). */
  labelSize: z.number().min(0.01).max(0.06),
  /** Stroke width in px at a 1080 short side. */
  stroke: z.number().min(0.5).max(6),
  /** `none` is transparent, to lay over any layer; `preview` draws a neutral placeholder plate. */
  backdrop: z.enum(["none", "preview"]),
});

export type UiAnnotateProps = z.infer<typeof uiAnnotateSchema>;

export const annotateFrames = (p: Pick<UiAnnotateProps, "items" | "buildAt" | "span">): number[] => {
  const auto = buildFrames(
    p.items.map((it) => ({ x: it.keys[0]!.x, y: it.keys[0]!.y })),
    p.buildAt,
    p.span,
  );
  return p.items.map((it, i) => it.at ?? auto[i]!);
};

export const uiAnnotateCues = (p: UiAnnotateProps) => {
  const frames = annotateFrames(p);
  const first = Math.min(...frames);
  return [
    {
      frame: first,
      kind: "reveal" as const,
      sfx: "tick" as const,
      weight: "support" as const,
      label: "annotations build",
    },
    ...(p.exitAt !== undefined
      ? [
          {
            frame: p.exitAt,
            kind: "exit" as const,
            sfx: "none" as const,
            weight: "support" as const,
            label: "annotations off",
          },
        ]
      : []),
  ];
};

const Handles: React.FC<{ w: number; h: number; colour: string; size: number; stroke: number }> = ({
  w,
  h,
  colour,
  size,
  stroke,
}) => (
  <>
    {[0, 0.5, 1].flatMap((fx) =>
      [0, 0.5, 1].map((fy) =>
        fx === 0.5 && fy === 0.5 ? null : (
          <div
            key={`${fx}-${fy}`}
            style={{
              position: "absolute",
              left: fx * w - size / 2,
              top: fy * h - size / 2,
              width: size,
              height: size,
              background: "#FFFFFF",
              border: `${stroke}px solid ${colour}`,
              boxSizing: "border-box",
            }}
          />
        ),
      ),
    )}
  </>
);

/**
 * Anchored annotations over any layer: boxes with dimension labels, coordinate tags, connector lines, selection
 * handles, named cursor tags and outline word chips, each pinned to keyframed points. Draw it over a plate, a capture
 * or footage; it paints nothing else. Positions are stage shares of the full frame.
 */
export const Annotations: React.FC<Omit<UiAnnotateProps, "backdrop">> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const frames = annotateFrames(p);
  if (p.exitAt !== undefined && frame >= p.exitAt) return null;
  const font = p.labelSize * Math.min(width, height);
  const sw = p.stroke * u;
  const anchor = (i: number) => {
    const it = p.items[i]!;
    const pt = trackPoint(frame, it.keys);
    const j = holdJitter(frame, `ann-${i}`, p.jitter * u);
    return { x: pt.x * width + j.x, y: pt.y * height + j.y };
  };
  const shown = (i: number) => frame >= frames[i]!;
  const labelStyle = (colour: string): React.CSSProperties => ({
    position: "absolute",
    fontFamily: geistMono,
    fontSize: font,
    lineHeight: 1,
    color: colour,
    whiteSpace: "nowrap",
    letterSpacing: "0.02em",
  });

  return (
    <AbsoluteFill style={{ mixBlendMode: p.blend === "normal" ? undefined : p.blend, fontFamily: geist }}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {p.items.map((it, i) => {
          if (it.connectTo === undefined || !shown(i) || !p.items[it.connectTo] || !shown(it.connectTo)) return null;
          const a = anchor(i);
          const b = anchor(it.connectTo);
          const c = it.colour ?? p.colour;
          return (
            <g key={i}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={sw} />
              <circle cx={a.x} cy={a.y} r={sw * 2.4} fill={c} />
              <circle cx={b.x} cy={b.y} r={sw * 2.4} fill={c} />
            </g>
          );
        })}
      </svg>
      {p.items.map((it, i) => {
        if (!shown(i)) return null;
        const c = it.colour ?? p.colour;
        const a = anchor(i);
        const w = (it.w ?? 0) * width;
        const h = (it.h ?? 0) * height;
        switch (it.kind) {
          case "box":
            return (
              <React.Fragment key={i}>
                <div
                  style={{
                    position: "absolute",
                    left: a.x - w / 2,
                    top: a.y - h / 2,
                    width: w,
                    height: h,
                    border: `${sw}px solid ${c}`,
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ ...labelStyle(c), left: a.x - w / 2, top: a.y + h / 2 + font * 0.35 }}>
                  {it.label || dimensionLabel(w, h)}
                </div>
              </React.Fragment>
            );
          case "tag":
            return (
              <React.Fragment key={i}>
                {w > 0 && h > 0 ? (
                  <div
                    style={{
                      position: "absolute",
                      left: a.x - w / 2,
                      top: a.y - h / 2,
                      width: w,
                      height: h,
                      border: `${sw}px solid ${c}`,
                      boxSizing: "border-box",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      position: "absolute",
                      left: a.x - sw * 2.4,
                      top: a.y - sw * 2.4,
                      width: sw * 4.8,
                      height: sw * 4.8,
                      borderRadius: sw * 4.8,
                      background: c,
                    }}
                  />
                )}
                <div
                  style={{
                    ...labelStyle(c),
                    left: a.x,
                    top: a.y - (h > 0 ? h / 2 : 0) - font * 1.4,
                    transform: "translateX(-50%)",
                  }}
                >
                  {it.label || coordinateLabel(a.x, a.y)}
                </div>
              </React.Fragment>
            );
          case "handles":
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: a.x - w / 2,
                  top: a.y - h / 2,
                  width: w,
                  height: h,
                  border: `${sw}px solid ${c}`,
                  boxSizing: "border-box",
                }}
              >
                <Handles w={w} h={h} colour={c} size={12 * u} stroke={sw} />
                {it.label ? (
                  <div
                    style={{
                      position: "absolute",
                      left: -sw,
                      bottom: "100%",
                      marginBottom: 8 * u,
                      padding: `${font * 0.25}px ${font * 0.45}px`,
                      background: c,
                      color: "#0A0A0A",
                      fontSize: font * 0.85,
                      fontWeight: 500,
                      borderRadius: 4 * u,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {it.label}
                  </div>
                ) : null}
              </div>
            );
          case "cursor": {
            const size = font * 1.6;
            return (
              <div key={i} style={{ position: "absolute", left: a.x, top: a.y }}>
                <svg
                  width={size}
                  height={size}
                  viewBox="0 0 24 24"
                  style={{
                    position: "absolute",
                    left: -size * 0.2,
                    top: -size * 0.1,
                    filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.25))",
                  }}
                >
                  <path
                    d="M5 2.5v17.2l4.6-4.4 2.9 6.6 3-1.3-2.9-6.5h6.3z"
                    fill={c}
                    stroke="#FFFFFF"
                    strokeWidth={1.4}
                    strokeLinejoin="round"
                  />
                </svg>
                {it.label ? (
                  <div
                    style={{
                      position: "absolute",
                      left: size * 0.6,
                      top: size * 0.75,
                      padding: `${font * 0.22}px ${font * 0.55}px`,
                      borderRadius: font,
                      background: c,
                      color: "#FFFFFF",
                      fontSize: font * 0.85,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {it.label}
                  </div>
                ) : null}
              </div>
            );
          }
          case "chip":
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: a.x,
                  top: a.y,
                  transform: "translateY(-50%)",
                  padding: `${font * 0.35}px ${font * 0.8}px`,
                  borderRadius: font * 2,
                  border: `${sw}px solid ${c}`,
                  color: c,
                  fontSize: font * 1.1,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                {it.label ?? "Label"}
              </div>
            );
        }
      })}
    </AbsoluteFill>
  );
};

/** A neutral placeholder plate for the preview: a soft ground with two rounded objects. Real films pass their own layer. */
const PreviewPlate: React.FC = () => (
  <AbsoluteFill style={{ background: "linear-gradient(160deg, #3F3F46, #18181B)" }}>
    <div
      style={{
        position: "absolute",
        left: "30%",
        top: "34%",
        width: "22%",
        height: "34%",
        borderRadius: "28%",
        background: "radial-gradient(circle at 35% 30%, #71717A, #27272A 70%)",
      }}
    />
    <div
      style={{
        position: "absolute",
        left: "60%",
        top: "50%",
        width: "14%",
        height: "22%",
        borderRadius: "50%",
        background: "radial-gradient(circle at 35% 30%, #A1A1AA, #3F3F46 70%)",
      }}
    />
  </AbsoluteFill>
);

export const UiAnnotate: React.FC<UiAnnotateProps> = ({ backdrop, ...rest }) => (
  <AbsoluteFill>
    {backdrop === "preview" ? <PreviewPlate /> : null}
    <Annotations {...rest} />
  </AbsoluteFill>
);
