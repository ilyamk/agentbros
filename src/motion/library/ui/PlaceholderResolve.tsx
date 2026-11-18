import React from "react";
import { z } from "zod";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { geist, Ground, surface } from "./surface";
import { growRectFrom, resolveEndOf, resolvePlan, resolveState, type Rect, type ResolveEntry } from "./ui-plan";

/**
 * placeholder-resolve: regions of a screen (or tiles of a wall) start as placeholders and resolve into their real
 * content on a stagger.
 *
 * API, for scenes and for other blocks (a video wall builds on it):
 * - `resolvePlan(regions, { start, step, order, origin, ring, grow, hold, dissolve })` (ui-plan.ts, pure) gives one
 *   `{ at, growEnd, resolveAt, resolveEnd }` per region. `order: "radial"` uses `stagger({ kind: "radial" })` from
 *   timing.ts, outward from `origin` (default the centre), ring by ring with `ring`.
 * - `resolveState(frame, entry)` gives `{ shown, grow, resolve }`; `growRectFrom(rect, grow, from?)` the rect while it grows.
 * - `<PlaceholderTile kind grow resolve frame colours radius>{content}</PlaceholderTile>` fills its positioned parent:
 *   the placeholder over any children (an `<Img>`, a `<Video>` from `@remotion/media`, a captured screen crop; the `white` kind blurs each tile with CSS, which adds up across a 100-tile wall), crossfading
 *   (`gradient`, `shimmer`) or un-blurring from white (`white`) as `resolve` goes 0 to 1.
 * - `<PlaceholderRegions regions plan kind ... render={(region, i) => content} />` lays tiles out on a stage.
 * The block itself takes `src` images per region under public/; real product screens are captured (`capture:app`),
 * never drawn. With no `src` a region shows a neutral placeholder card.
 */

export const placeholderKindSchema = z.enum(["gradient", "shimmer", "white"]);
export type PlaceholderKind = z.infer<typeof placeholderKindSchema>;

const regionSchema = z.object({
  /** Left, top, width, height as shares of the stage. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().positive().max(1),
  h: z.number().positive().max(1),
  /** Image under public/ (a crop of the captured screen) the region resolves into; empty draws a neutral card. */
  src: z.string().optional(),
  /** Text of the neutral card when there is no `src`. */
  label: z.string().optional(),
});
export type PlaceholderRegion = z.infer<typeof regionSchema>;

export const placeholderResolveSchema = z.object({
  /** `gradient` (ace: a soft two-colour fill), `shimmer` (nexaa: scrolling bands, can grow from a point), `white` (ugc-app: blurred white blocks). */
  kind: placeholderKindSchema,
  regions: z.array(regionSchema).min(1),
  start: z.number().int().min(0),
  /** Frames between region starts (rings with `order: "radial"`). */
  step: z.number().min(0),
  order: z.enum(["index", "reading", "radial"]),
  /** Radial origin in stage shares. */
  origin: z.object({ x: z.number(), y: z.number() }).optional(),
  ring: z.number().positive().optional(),
  /** Frames a placeholder grows from a point to its rect; 0 shows it whole. */
  grow: z.number().int().min(0),
  /** Where it grows from: `start` (its left-middle, like a reply line) or `centre`. */
  growFrom: z.enum(["start", "centre"]).optional(),
  hold: z.number().int().min(0),
  /** Frames from placeholder to content. */
  dissolve: z.number().int().min(1),
  /** Two placeholder colours; absent uses the accent's soft tints. */
  colours: z.tuple([z.string(), z.string()]).optional(),
  accent: z.string(),
  tone: z.enum(["light", "dark"]),
  /** Corner radius in stage pixels at 1080 short side. */
  radius: z.number().min(0),
  /** Stage inset as a share of the frame on every side. */
  inset: z.number().min(0).max(0.3),
  /** `preview` paints the tone's ground; `transparent` lays the regions over any layer. */
  ground: z.enum(["preview", "transparent"]),
});

export type PlaceholderResolveProps = z.infer<typeof placeholderResolveSchema>;

export const placeholderPlan = (
  p: Pick<
    PlaceholderResolveProps,
    "regions" | "start" | "step" | "order" | "origin" | "ring" | "grow" | "hold" | "dissolve"
  >,
): ResolveEntry[] =>
  resolvePlan(p.regions, {
    start: p.start,
    step: p.step,
    order: p.order,
    origin: p.origin,
    ring: p.ring,
    grow: p.grow,
    hold: p.hold,
    dissolve: p.dissolve,
  });

export const placeholderResolveCues = (p: PlaceholderResolveProps) => {
  const plan = placeholderPlan(p);
  const first = Math.min(...plan.map((e) => e.at));
  const firstResolve = Math.min(...plan.map((e) => e.resolveAt));
  return [
    {
      frame: first,
      kind: "reveal" as const,
      sfx: "none" as const,
      weight: "support" as const,
      label: "placeholders appear",
    },
    {
      frame: firstResolve,
      kind: "reveal" as const,
      sfx: "tick" as const,
      weight: "support" as const,
      label: "first region resolves",
    },
    {
      frame: resolveEndOf(plan),
      kind: "land" as const,
      sfx: "none" as const,
      weight: "hero" as const,
      label: "every region is content",
    },
  ];
};

const softTints = (accent: string, tone: "light" | "dark"): [string, string] => {
  const s = surface(tone, accent);
  return tone === "light"
    ? [s.accentSoft.replace(/[\d.]+\)$/, "0.32)"), s.accentSoft.replace(/[\d.]+\)$/, "0.12)")]
    : [s.accentSoft.replace(/[\d.]+\)$/, "0.45)"), s.accentSoft.replace(/[\d.]+\)$/, "0.18)")];
};

/** The placeholder over its content. Fills its positioned parent; `frame` drives the shimmer's scroll. */
export const PlaceholderTile: React.FC<{
  kind: PlaceholderKind;
  /** 0..1 how far the placeholder has grown (the caller sizes the parent; this only gates the content). */
  grow?: number;
  /** 0..1 placeholder to content. */
  resolve: number;
  frame: number;
  colours: [string, string];
  radius?: number;
  /** Blur of the white block in px at resolve 0; ugc-app's tiles read about 2% of their width. */
  blur?: number;
  children?: React.ReactNode;
}> = ({ kind, grow = 1, resolve, frame, colours, radius = 0, blur = 18, children }) => {
  const r = Math.min(1, Math.max(0, resolve));
  const contentOpacity = grow >= 1 ? r : 0;
  const fill =
    kind === "shimmer"
      ? {
          backgroundImage: `linear-gradient(100deg, ${colours[0]} 0%, ${colours[1]} 25%, ${colours[0]} 50%, ${colours[1]} 75%, ${colours[0]} 100%)`,
          backgroundSize: "200% 100%",
          backgroundPosition: `${-((frame * 2.5) % 100)}% 0%`,
        }
      : kind === "gradient"
        ? { backgroundImage: `linear-gradient(135deg, ${colours[0]}, ${colours[1]})` }
        : { backgroundColor: "#FFFFFF" };
  return (
    <div style={{ position: "absolute", inset: 0, borderRadius: radius, overflow: "hidden" }}>
      {children && contentOpacity > 0 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: kind === "white" ? 1 : contentOpacity,
            filter: kind === "white" && r < 1 ? `blur(${(1 - r) * blur}px)` : undefined,
          }}
        >
          {children}
        </div>
      ) : null}
      {r < 1 ? (
        <div
          style={{
            position: "absolute",
            inset: kind === "white" ? -blur : 0,
            ...fill,
            opacity: 1 - r,
            filter: kind === "white" ? `blur(${blur * 0.6}px)` : undefined,
          }}
        />
      ) : null}
    </div>
  );
};

/** Tiles laid out on a stage of `width` x `height` px; `render` draws each region's content. */
export const PlaceholderRegions: React.FC<{
  regions: readonly Rect[];
  plan: readonly ResolveEntry[];
  kind: PlaceholderKind;
  width: number;
  height: number;
  colours: [string, string];
  radius?: number;
  growFrom?: "start" | "centre";
  render: (i: number) => React.ReactNode;
}> = ({ regions, plan, kind, width, height, colours, radius = 0, growFrom = "start", render }) => {
  const frame = useCurrentFrame();
  return (
    <>
      {regions.map((rect, i) => {
        const st = resolveState(frame, plan[i]!);
        if (!st.shown) return null;
        const g = growRectFrom(
          rect,
          st.grow,
          growFrom === "centre" ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : undefined,
        );
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: g.x * width,
              top: g.y * height,
              width: Math.max(1, g.w * width),
              height: Math.max(1, g.h * height),
            }}
          >
            <PlaceholderTile
              kind={kind}
              grow={st.grow}
              resolve={st.resolve}
              frame={frame}
              colours={colours}
              radius={Math.min(radius, (g.h * height) / 2)}
            >
              <div style={{ position: "absolute", left: 0, top: 0, width: rect.w * width, height: rect.h * height }}>
                {render(i)}
              </div>
            </PlaceholderTile>
          </div>
        );
      })}
    </>
  );
};

/** Neutral stand-in content: a card with a label and grey lines. It reads as a placeholder on purpose. */
const NeutralCard: React.FC<{ label: string; tone: "light" | "dark"; accent: string; u: number }> = ({
  label,
  tone,
  accent,
  u,
}) => {
  const s = surface(tone, accent);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: s.card,
        border: `1px solid ${s.border}`,
        padding: 28 * u,
        display: "flex",
        flexDirection: "column",
        gap: 14 * u,
        boxSizing: "border-box",
      }}
    >
      <div style={{ fontSize: 26 * u, fontWeight: 600, color: s.text }}>{label}</div>
      {[0.82, 0.64, 0.72].map((w, k) => (
        <div key={k} style={{ height: 14 * u, width: `${w * 100}%`, borderRadius: 7 * u, background: s.muted }} />
      ))}
    </div>
  );
};

/** Regions start as placeholders (gradient, shimmer or white blur) and resolve into their content on a stagger. */
export const PlaceholderResolve: React.FC<PlaceholderResolveProps> = (p) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const s = surface(p.tone, p.accent);
  const plan = placeholderPlan(p);
  const colours = p.colours ?? softTints(p.accent, p.tone);
  const sw = width * (1 - 2 * p.inset);
  const sh = height * (1 - 2 * p.inset);
  const stage = (
    <div style={{ position: "absolute", left: width * p.inset, top: height * p.inset, width: sw, height: sh }}>
      <PlaceholderRegions
        regions={p.regions}
        plan={plan}
        kind={p.kind}
        width={sw}
        height={sh}
        colours={colours}
        radius={p.radius * u}
        growFrom={p.growFrom}
        render={(i) => {
          const r = p.regions[i]!;
          return r.src ? (
            <Img src={staticFile(r.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <NeutralCard label={r.label ?? `Region ${i + 1}`} tone={p.tone} accent={p.accent} u={u} />
          );
        }}
      />
    </div>
  );
  return p.ground === "transparent" ? (
    <AbsoluteFill style={{ fontFamily: geist }}>{stage}</AbsoluteFill>
  ) : (
    <Ground s={s}>{stage}</Ground>
  );
};
