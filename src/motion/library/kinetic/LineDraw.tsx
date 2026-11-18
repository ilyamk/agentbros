import React, { useId } from "react";
import { useCurrentFrame } from "remotion";
import { primaryFont } from "../../../lib/fonts";
import { toFrame, useFontsReady, useGsapTimeline } from "../../gsap";
import { intendedOverflow } from "../overflow";
import type { Cue } from "../types";
import { Stage, useSafeArea } from "../typography/Stage";
import { brushOutline, lineDrawPlan, penTip, type LineDrawProps } from "./line-draw-math";

export {
  brushMonogramPreset,
  brushOutline,
  brushWidth,
  lineDrawPlan,
  lineDrawSchema,
  penTip,
  penWritePreset,
  strokeEase,
} from "./line-draw-math";
export type { BrushOptions, LineDrawProps } from "./line-draw-math";

export const lineDrawCues = (props: LineDrawProps): Cue[] => {
  const plan = lineDrawPlan(props);
  const cues: Cue[] = [{ frame: toFrame(plan.start), kind: "reveal", sfx: "whoosh", weight: "support", label: "draw" }];
  if (plan.hero >= 0)
    cues.push({
      frame: toFrame(plan.hero),
      kind: "hit",
      sfx: props.dot ? "pop" : "click",
      weight: "hero",
      label: "accent",
    });
  cues.push({ frame: toFrame(plan.drawn), kind: "land", sfx: "none", weight: "support", label: "drawn" });
  if (props.caption)
    cues.push({ frame: toFrame(plan.caption), kind: "reveal", sfx: "none", weight: "support", label: "caption" });
  return cues;
};

/** A plain pen: a long body and a nib whose point is the origin, pointing down-left at `angle`. */
const Pen: React.FC<{ x: number; y: number; size: number; angle: number; colour: string }> = ({
  x,
  y,
  size,
  angle,
  colour,
}) => (
  <g transform={`translate(${x} ${y}) rotate(${angle})`}>
    <path d={`M0,0 L${size * 0.06},${-size * 0.16} L${-size * 0.06},${-size * 0.16} Z`} fill={colour} />
    <rect x={-size * 0.06} y={-size} width={size * 0.12} height={size * 0.84} rx={size * 0.04} fill={colour} />
  </g>
);

/**
 * DrawSVG line art: strokes draw on one after another with an ease that slows into each end, the accent stroke last
 * and in colour, a dot pops where it ends, and a caption rises from a mask. For explaining a product, a flow or a
 * result as a drawing instead of a stock icon. `brush` turns each stroke into a variable-width brush revealed along its
 * centre line (a monogram written large and blurred, settling to size); `follower` puts a pen on the drawing tip.
 */
export const LineDraw: React.FC<LineDrawProps> = (props) => {
  const { strokes, viewBox, dot, caption, color, accent, background, strokeWidth, brush, follower } = props;
  const frame = useCurrentFrame();
  const id = `ld${useId().replaceAll(":", "")}`;
  const safe = useSafeArea();
  const ready = useFontsReady([`600 40px ${primaryFont}`]);
  const plan = lineDrawPlan(props);
  const [vw, vh] = viewBox;
  const captionSize = Math.min(
    safe.vertical ? safe.width * 0.08 : safe.height * 0.075,
    (safe.width * 0.95) / Math.max(1, caption.length * 0.52),
  );
  const room = { w: safe.width * (safe.vertical ? 1 : 0.8), h: safe.height * (safe.vertical ? 0.55 : 0.7) };
  const scale = Math.min(room.w / vw, room.h / vh);
  const scope = useGsapTimeline<HTMLDivElement>(
    ({ timeline, selector }) => {
      const paths = selector("[data-stroke]") as unknown as SVGPathElement[];
      timeline.addLabel("draw", plan.start).addLabel("drawn", plan.drawn);
      paths.forEach((path, index) => {
        timeline.fromTo(
          path,
          { drawSVG: "0% 0%" },
          { drawSVG: "0% 100%", duration: props.draw, ease: "kinetic.inOut" },
          plan.starts[index],
        );
      });
      if (brush) {
        // The brush enters large and blurred and settles to size on expo.out over one stroke's draw (or `settle`).
        const [art] = selector("[data-art]");
        if (art) {
          timeline.fromTo(
            art,
            { scale: brush.entryScale, transformOrigin: "50% 50%" },
            { scale: 1, duration: brush.settle ?? props.draw, ease: "expo.out", immediateRender: false },
            "draw",
          );
          if (brush.entryBlur > 0)
            timeline.fromTo(
              art,
              { filter: `blur(${brush.entryBlur}px)` },
              { filter: "blur(0px)", duration: 5 / 30, ease: "power1.out", immediateRender: false },
              "draw",
            );
        }
      }
      if (plan.hero >= 0) {
        timeline.addLabel("accent", plan.hero);
        const [mark] = selector("[data-dot]");
        if (mark)
          timeline.fromTo(
            mark,
            { scale: 0, transformOrigin: "50% 50%" },
            { scale: 1, duration: 0.45, ease: "back.out(2.6)" },
            "accent",
          );
      }
      if (caption) {
        timeline.addLabel("caption", plan.caption);
        timeline.fromTo(
          selector("[data-caption]"),
          { yPercent: 110 },
          { yPercent: 0, duration: 0.7, ease: "kinetic.out" },
          "caption",
        );
      }
    },
    { dependencies: [ready, JSON.stringify(props), safe.vertical] },
  );
  if (!ready) return <Stage background={background}>{null}</Stage>;
  const seconds = frame / 30;
  const tip = follower ? penTip(props, seconds) : null;
  // The brush's entry scale carries the drawing past the safe zone on purpose for its first frames.
  const entering = !!brush && brush.entryScale > 1.05 && seconds < plan.start + props.draw * 0.5;
  return (
    <Stage background={background}>
      <div
        ref={scope}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: captionSize * 1.1,
        }}
      >
        {/* GSAP scales and blurs this wrapper (never the <svg>, whose transform GSAP writes as an SVG attribute in viewBox units). */}
        <div
          data-art
          style={{ display: "flex", width: vw * scale, height: vh * scale }}
          {...intendedOverflow(entering, "brush enters at its entry scale and settles inside the frame")}
        >
          <svg viewBox={`0 0 ${vw} ${vh}`} width={vw * scale} height={vh * scale} style={{ overflow: "visible" }}>
            {brush ? (
              <>
                <defs>
                  {strokes.map((stroke, index) => (
                    <mask
                      key={index}
                      id={`${id}-m${index}`}
                      maskUnits="userSpaceOnUse"
                      x={-vw}
                      y={-vh}
                      width={vw * 3}
                      height={vh * 3}
                    >
                      <path
                        data-stroke
                        d={stroke.d}
                        fill="none"
                        stroke="#fff"
                        strokeWidth={brush.width * 1.6}
                        strokeLinecap="butt"
                        strokeLinejoin="round"
                      />
                    </mask>
                  ))}
                </defs>
                {strokes.map((stroke, index) => (
                  <path
                    key={index}
                    d={brushOutline(stroke.d, stroke.accent ? brush.width * 1.15 : brush.width, brush.taper)}
                    fill={stroke.accent ? accent : color}
                    mask={`url(#${id}-m${index})`}
                  />
                ))}
              </>
            ) : (
              strokes.map((stroke, index) => (
                <path
                  key={index}
                  data-stroke
                  d={stroke.d}
                  fill="none"
                  stroke={stroke.accent ? accent : color}
                  strokeWidth={stroke.accent ? strokeWidth * 1.4 : strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))
            )}
            {dot && plan.hero >= 0 ? (
              <circle data-dot cx={dot[0]} cy={dot[1]} r={strokeWidth * 3.2} fill={accent} />
            ) : null}
            {follower && tip ? (
              <Pen x={tip.x} y={tip.y} size={follower.size} angle={follower.angle} colour={follower.colour} />
            ) : null}
          </svg>
        </div>
        {caption ? (
          <div style={{ overflow: "hidden", paddingBottom: captionSize * 0.12 }}>
            <div
              data-caption
              style={{
                fontFamily: primaryFont,
                fontWeight: 600,
                fontSize: captionSize,
                letterSpacing: "-0.025em",
                color,
                textAlign: "center",
              }}
            >
              {caption}
            </div>
          </div>
        ) : null}
      </div>
    </Stage>
  );
};

export const lineDrawDefaults: LineDrawProps = {
  strokes: [
    { d: "M40,40 H560 Q580,40 580,60 V340 Q580,360 560,360 H40 Q20,360 20,340 V60 Q20,40 40,40 Z", accent: false },
    { d: "M20,90 H580", accent: false },
    { d: "M56,65 h0.01 M82,65 h0.01 M108,65 h0.01", accent: false },
    { d: "M80,310 H520", accent: false },
    { d: "M80,310 V140", accent: false },
    { d: "M140,300 V250 M210,300 V230 M280,300 V240 M350,300 V205 M420,300 V190", accent: false },
    { d: "M100,280 C170,270 200,230 260,232 C320,234 340,200 390,178 C430,160 460,140 500,124", accent: true },
  ],
  viewBox: [600, 400],
  dot: [500, 124],
  caption: "Revenue, up and to the right.",
  color: "#111111",
  accent: "#ff5a1f",
  background: "#f3f1ec",
  strokeWidth: 5,
  at: 6,
  stagger: 0.16,
  draw: 0.7,
};
