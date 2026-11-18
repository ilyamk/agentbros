import React, { useLayoutEffect, useMemo, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { faceReady, face as loadFace, type FaceId } from "./faces";
import { planCaptionFrame, presetLayout, type Measure, type PlannedWord } from "./plan";
import type { CaptionBacking, CaptionStyleProps } from "./style";

const fontString = (id: FaceId, px: number) => {
  const f = loadFace(id);
  return `${f.fontStyle} ${f.fontWeight} ${px}px ${f.fontFamily}`;
};

/** Canvas measurement of the loaded faces at 100 px, cached; widths include the face's letter spacing. */
const makeMeasure = (): Measure => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const widths = new Map<string, number>();
  const metrics = new Map<FaceId, { ascent: number; descent: number }>();
  const set = (id: FaceId) => {
    ctx.font = fontString(id, 100);
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${loadFace(id).letterSpacingEm * 100}px`;
  };
  const faceMetrics = (id: FaceId) => {
    let m = metrics.get(id);
    if (!m) {
      set(id);
      const probe = ctx.measureText("Hg");
      m = { ascent: probe.fontBoundingBoxAscent / 100, descent: probe.fontBoundingBoxDescent / 100 };
      metrics.set(id, m);
    }
    return m;
  };
  return {
    width: (text, id) => {
      const key = `${id}\u0000${text}`;
      let w = widths.get(key);
      if (w === undefined) {
        set(id);
        w = ctx.measureText(text).width / 100;
        widths.set(key, w);
      }
      return w;
    },
    ascent: (id) => faceMetrics(id).ascent,
    descent: (id) => faceMetrics(id).descent,
  };
};

/** Faces a preset may draw: its own, and the serif italic for a mixed page's second key word. */
const facesOf = (p: CaptionStyleProps): FaceId[] =>
  p.layout === "mixed" && p.emphasis.serif ? [p.face, "serif-italic"] : [p.face];

/** Holds the render until every face of the preset has loaded, then measures with it. */
const useMeasure = (p: CaptionStyleProps, sample: string): Measure | null => {
  const key = facesOf(p).join(",");
  const [measure, setMeasure] = useState<{ key: string; measure: Measure } | null>(null);
  useLayoutEffect(() => {
    const handle = delayRender(`Caption faces ${key}`);
    let live = true;
    void Promise.all(
      key.split(",").map(async (id) => {
        await faceReady(id as FaceId);
        await document.fonts.load(fontString(id as FaceId, 100), sample || "Hg");
      }),
    )
      .then(() => {
        if (live) setMeasure({ key, measure: makeMeasure() });
      })
      .finally(() => continueRender(handle));
    return () => {
      live = false;
      continueRender(handle);
    };
  }, [key, sample]);
  return measure?.key === key ? measure.measure : null;
};

const rgba = (hex: string, opacity: number) => {
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const alpha = full.length === 9 ? parseInt(full.slice(7, 9), 16) / 255 : 1;
  return `rgba(${parseInt(full.slice(1, 3), 16)},${parseInt(full.slice(3, 5), 16)},${parseInt(full.slice(5, 7), 16)},${(alpha * opacity).toFixed(3)})`;
};

const Word: React.FC<{ w: PlannedWord; backing: CaptionBacking }> = ({ w, backing }) => {
  const f = loadFace(w.face);
  const outline = w.treated && backing.kind === "outline";
  const shadow =
    w.treated && backing.kind === "shadow"
      ? `${backing.x * w.fontSize}px ${backing.y * w.fontSize}px ${backing.blur * w.fontSize}px ${rgba(backing.colour, backing.opacity)}`
      : undefined;
  const type: React.CSSProperties = {
    fontFamily: f.fontFamily,
    fontWeight: f.fontWeight,
    fontStyle: f.fontStyle,
    fontSize: w.fontSize,
    letterSpacing: `${f.letterSpacingEm}em`,
  };
  return (
    <div
      data-avc-text-role="spoken-caption"
      style={{
        position: "absolute",
        left: w.left,
        top: w.top,
        width: w.width,
        height: w.height,
        padding: `0 ${w.padX}px`,
        boxSizing: "border-box",
        ...type,
        lineHeight: `${w.height}px`,
        whiteSpace: "pre",
        color: outline ? "transparent" : w.colour,
        textShadow: shadow,
        opacity: w.opacity,
        transform: `translateY(${w.translateY}px) scale(${w.scale})`,
        filter: w.blurPx > 0.05 ? `blur(${w.blurPx}px)` : undefined,
      }}
    >
      {w.text}
      {outline ? (
        // An SVG stroke with round joins: CSS text-stroke mitres, which spikes on V, W and M at caption widths.
        <svg
          aria-hidden
          width={w.width}
          height={w.height}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            filter:
              backing.depth > 0
                ? `drop-shadow(0 ${backing.depth * w.fontSize}px 0 ${rgba(backing.colour, 1)})`
                : undefined,
          }}
        >
          <text
            x={w.padX}
            y={w.height / 2}
            dominantBaseline="central"
            style={type}
            fill={w.colour}
            stroke={backing.colour}
            strokeWidth={backing.width * 2 * w.fontSize}
            strokeLinejoin="round"
            strokeLinecap="round"
            paintOrder="stroke"
          >
            {w.text}
          </text>
        </svg>
      ) : null}
    </div>
  );
};

/**
 * The caption renderer every preset uses: pages from the words, words laid out and animated by `planCaptionFrame`,
 * drawn with the preset's backing. Every value is a function of the frame.
 */
export const CaptionPages: React.FC<{ p: CaptionStyleProps }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const layout = useMemo(() => presetLayout(p, width, height), [p, width, height]);
  const sample = useMemo(
    () =>
      p.words
        .map((word) => word.text)
        .join(" ")
        .slice(0, 400),
    [p.words],
  );
  const measure = useMeasure(p, sample);
  if (!measure) return null;
  const plan = planCaptionFrame(p, layout, measure, frame, fps, height);
  if (!plan) return null;
  const inline = p.placement === "inline";
  const { page } = plan;
  const content = (
    <div
      lang={p.language}
      style={{
        position: "absolute",
        inset: 0,
        opacity: page.opacity,
        transform: `translateY(${page.translateY}px) scale(${page.scale})`,
        transformOrigin: `${page.originX}px ${page.originY}px`,
        filter: page.blurPx > 0.05 ? `blur(${page.blurPx}px)` : undefined,
      }}
    >
      {plan.boxes.map((box) => (
        <div
          key={box.key}
          style={{
            position: "absolute",
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            borderRadius: box.radius,
            backgroundColor: box.fill,
            opacity: box.opacity,
          }}
        />
      ))}
      {plan.activeBox ? (
        <div
          style={{
            position: "absolute",
            left: plan.activeBox.left,
            top: plan.activeBox.top,
            width: plan.activeBox.width,
            height: plan.activeBox.height,
            borderRadius: plan.activeBox.radius,
            backgroundColor: plan.activeBox.fill,
          }}
        />
      ) : null}
      {plan.words.map((w) => (
        <Word key={w.key} w={w} backing={plan.backing} />
      ))}
      {plan.cursor ? (
        <div
          style={{
            position: "absolute",
            left: plan.cursor.left,
            top: plan.cursor.top,
            width: plan.cursor.width,
            height: plan.cursor.height,
            backgroundColor: plan.cursor.colour,
          }}
        />
      ) : null}
      {plan.emoji ? (
        <div
          style={{
            position: "absolute",
            left: plan.emoji.centreX - plan.emoji.size,
            width: plan.emoji.size * 2,
            top: plan.emoji.bottom - plan.emoji.size * 1.1,
            textAlign: "center",
            fontSize: plan.emoji.size,
            lineHeight: 1.1,
            transform: `translateY(${(1 - plan.emoji.rise) * plan.emoji.size * 0.4}px) scale(${plan.emoji.rise})`,
          }}
        >
          {plan.emoji.text}
        </div>
      ) : null}
    </div>
  );
  if (inline)
    return (
      <div
        style={{
          position: "relative",
          width: layout.box.right - layout.box.left,
          height: Math.max(...plan.words.map((w) => w.top + w.height)),
          margin: "0 auto",
        }}
      >
        {content}
      </div>
    );
  return <AbsoluteFill style={{ pointerEvents: "none" }}>{content}</AbsoluteFill>;
};

/** A muted stand-in for footage behind a preview, so caption contrast is judged over picture, not black. */
export const PreviewFootage: React.FC<{ children: React.ReactNode; tone?: "warm" | "cool" }> = ({
  children,
  tone = "warm",
}) => (
  <AbsoluteFill
    style={{
      background:
        tone === "warm"
          ? "radial-gradient(120% 80% at 30% 25%, #d8c6b0 0%, #8d7863 45%, #3b3129 100%)"
          : "radial-gradient(120% 80% at 70% 30%, #c3d3df 0%, #5b6f80 45%, #252f3a 100%)",
    }}
  >
    {children}
  </AbsoluteFill>
);
