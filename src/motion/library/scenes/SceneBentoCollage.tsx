import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { CAMERA_EASE } from "../camera/ParallaxRig";
import type { Cue } from "../types";
import { HERO_SNAP_SHARE, HERO_SNAP_STEPS, heroSnapRect, heroSnapRects } from "./scene-plan";
import { ARRIVE, groundRole, MaybeFinish, sceneBaseSchema, useLook } from "./shared";

const tileSchema = z.object({
  kind: z.enum(["word", "stat", "chips", "image", "colour"]),
  /** Word, number, or comma-separated chips. */
  text: z.string(),
  /** Small caption; for an image, its alt line. */
  sub: z.string(),
  /** Image path inside public/ (kind "image"). */
  src: z.string().optional(),
  /** Which ground the tile sits on: the style's light ground, its surface, the accent or the ink. */
  tone: z.enum(["light", "surface", "accent", "ink"]),
});

export type BentoTile = z.infer<typeof tileSchema>;

export const sceneBentoCollageSchema = sceneBaseSchema.extend({
  /** Seven tiles, in the order they land; the layout places them in a fixed bento of mixed spans. */
  tiles: z.array(tileSchema).length(7),
  /** Frame the first tile lands. */
  at: z.number().int().min(0),
  /** Frames between tile landings, in order; a falling list accelerates the build. The last value repeats. */
  steps: z.array(z.number().int().min(1)).min(1),
  /** Frame the camera pushes into `hero` until it fills the frame and becomes the next shot's ground; -1 holds. */
  pushAt: z.number(),
  hero: z.number().int().min(0).max(6),
  /**
   * Hero snap (cashfree): the `hero` tile starts full bleed and on this frame jumps in one frame to a centred card
   * (`heroShare` of the width) on the ink ground; the other six tiles then cut on around it every 1-2 frames
   * (`snapSteps`), no tween. -1 or absent: the default build.
   */
  heroSnap: z.number().int().min(-1).optional(),
  heroShare: z.number().min(0.3).max(0.9).optional(),
  snapSteps: z.array(z.number().int().min(1)).min(1).optional(),
});

export type SceneBentoCollageProps = z.infer<typeof sceneBentoCollageSchema>;

const PUSH_FRAMES = 16;

export const bentoLandings = (at: number, steps: readonly number[]): number[] => {
  const out: number[] = [];
  let frame = at;
  for (let i = 0; i < 7; i++) {
    out.push(frame);
    frame += steps[Math.min(i, steps.length - 1)]!;
  }
  return out;
};

/** Frames the six tiles around the hero cut on in the hero-snap mode: from the frame after the snap, `snapSteps` apart. */
export const heroSnapLandings = (heroSnap: number, snapSteps: readonly number[] = HERO_SNAP_STEPS): number[] =>
  bentoLandings(heroSnap + 1, snapSteps).slice(0, 6);

export const sceneBentoCollageCues = ({
  at,
  steps,
  pushAt,
  heroSnap,
  snapSteps,
}: Pick<SceneBentoCollageProps, "at" | "steps" | "pushAt" | "heroSnap" | "snapSteps">): Cue[] =>
  heroSnap !== undefined && heroSnap >= 0
    ? [
        { frame: heroSnap, kind: "cut", sfx: "impact", weight: "hero", label: "full-bleed photo snaps to the card" },
        ...heroSnapLandings(heroSnap, snapSteps).map((frame, i): Cue => ({
          frame,
          kind: "land",
          sfx: "tick",
          weight: "support",
          label: `tile ${i + 1} cuts on`,
        })),
        ...(pushAt >= 0
          ? [
              {
                frame: pushAt + PUSH_FRAMES,
                kind: "cut",
                sfx: "whoosh",
                weight: "hero",
                label: "hero tile fills the frame",
              } as Cue,
            ]
          : []),
      ]
    : [
        ...bentoLandings(at, steps).map((frame, i): Cue => ({
          frame,
          kind: "land",
          sfx: i === 6 ? "pop" : "tick",
          weight: "support",
          label: `tile ${i + 1}`,
        })),
        ...(pushAt >= 0
          ? [
              {
                frame: pushAt + PUSH_FRAMES,
                kind: "cut",
                sfx: "whoosh",
                weight: "hero",
                label: "hero tile fills the frame",
              } as Cue,
            ]
          : []),
      ];

/** Grid cells (column, row, span columns, span rows) of the seven tiles. */
const LANDSCAPE = {
  cols: 4,
  rows: 3,
  cells: [
    [0, 0, 2, 2],
    [2, 0, 1, 1],
    [3, 0, 1, 1],
    [2, 1, 1, 1],
    [3, 1, 1, 2],
    [0, 2, 1, 1],
    [1, 2, 2, 1],
  ],
};
const VERTICAL = {
  cols: 2,
  rows: 6,
  cells: [
    [0, 0, 2, 2],
    [0, 2, 1, 1],
    [1, 2, 1, 1],
    [0, 3, 1, 1],
    [1, 3, 1, 2],
    [0, 4, 1, 1],
    [0, 5, 2, 1],
  ],
};

/**
 * A brand board: seven tiles (hero word, stats, UI chips, photos, colour) land one by one in a bento of mixed spans,
 * accelerating, on the light ground; then the camera pushes into the hero tile until it is the next shot's ground.
 */
export const SceneBentoCollage: React.FC<SceneBentoCollageProps> = ({
  styleId,
  finish,
  tiles,
  at,
  steps,
  pushAt,
  hero,
  heroSnap = -1,
  heroShare = HERO_SNAP_SHARE,
  snapSteps = HERO_SNAP_STEPS,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const u = Math.min(width, height) / 1080;
  const { displayFamily, bodyFamily, palette } = useLook(styleId);
  const light = groundRole(styleId, "light");
  const tone = (name: BentoTile["tone"]) =>
    name === "surface" ? { ...light, ground: palette.surface } : groundRole(styleId, name);
  const layout = vertical ? VERTICAL : LANDSCAPE;
  const pad = 56 * u;
  const gap = 20 * u;
  const cw = (width - pad * 2 - gap * (layout.cols - 1)) / layout.cols;
  const ch = (height - pad * 2 - gap * (layout.rows - 1)) / layout.rows;
  const snapping = heroSnap >= 0;
  const snap = heroSnapRects(width, height, heroShare, gap);
  const others = tiles.map((_, i) => i).filter((i) => i !== hero);
  const rects = snapping
    ? tiles.map((_, i) =>
        i === hero ? heroSnapRect(frame, heroSnap, width, height, snap.hero) : snap.tiles[others.indexOf(i)]!,
      )
    : layout.cells.map(([c, r, sc, sr]) => ({
        x: pad + c! * (cw + gap),
        y: pad + r! * (ch + gap),
        w: sc! * cw + (sc! - 1) * gap,
        h: sr! * ch + (sr! - 1) * gap,
      }));
  const snapLands = heroSnapLandings(heroSnap, snapSteps);
  const lands = snapping
    ? tiles.map((_, i) => (i === hero ? 0 : snapLands[others.indexOf(i)]!))
    : bentoLandings(at, steps);
  // Push: scale and move so the hero tile covers the frame exactly when the push ends.
  const target = rects[hero]!;
  const push =
    pushAt < 0
      ? 0
      : interpolate(frame, [pushAt, pushAt + PUSH_FRAMES], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: CAMERA_EASE,
        });
  const full = Math.max(width / target.w, height / target.h);
  const scale = full ** push;
  const tx = (width / 2 - (target.x + target.w / 2)) * push;
  const ty = (height / 2 - (target.y + target.h / 2)) * push;
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="scene-bento">
      <AbsoluteFill
        style={{ backgroundColor: snapping ? groundRole(styleId, "ink").ground : light.ground, overflow: "hidden" }}
      >
        <AbsoluteFill
          style={{
            transform: `translate(${tx * scale}px, ${ty * scale}px) scale(${scale})`,
            transformOrigin: "50% 50%",
          }}
        >
          {tiles.map((tile, i) => {
            const rect = rects[i]!;
            // Hero snap: every tile cuts on whole on its frame, no tween (cashfree).
            const p = snapping
              ? frame >= lands[i]!
                ? 1
                : 0
              : interpolate(frame, [lands[i]!, lands[i]! + 7], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: ARRIVE,
                });
            if (p <= 0) return null;
            const g = tone(tile.tone);
            const radius = snapping && i === hero && frame < heroSnap ? 0 : 28 * u * (i === hero ? 1 - push : 1);
            // Hero snap: the side panels are narrow, so fit inside their padding (the default build keeps its measure).
            const big = Math.min(
              rect.h * 0.46,
              ((snapping ? rect.w - 60 * u : rect.w) * (snapping ? 1.3 : 1.5)) / Math.max(tile.text.length, 2),
            );
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: rect.x,
                  top: rect.y,
                  width: rect.w,
                  height: rect.h,
                  borderRadius: radius,
                  overflow: "hidden",
                  backgroundColor: g.ground,
                  clipPath: p < 1 ? `inset(${(1 - p) * 100}% 0 0 0 round ${radius}px)` : undefined,
                  border:
                    tile.tone === "light"
                      ? `${Math.max(1, 2 * u)}px solid color-mix(in srgb, ${g.ink} 10%, transparent)`
                      : undefined,
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    padding: 30 * u,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-end",
                    transform: `translateY(${(1 - p) * 40 * u}px)`,
                  }}
                >
                  {tile.kind === "image" && tile.src ? (
                    <Img
                      src={staticFile(tile.src)}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : null}
                  {tile.kind === "word" || tile.kind === "stat" ? (
                    <div
                      style={{
                        fontFamily: displayFamily,
                        fontWeight: 700,
                        fontSize: big,
                        letterSpacing: "-0.05em",
                        lineHeight: 0.92,
                        color: tile.kind === "stat" ? g.accent : g.ink,
                        whiteSpace: "pre",
                      }}
                    >
                      {tile.text}
                    </div>
                  ) : null}
                  {tile.kind === "chips" ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 * u }}>
                      {tile.text.split(",").map((chip, c, all) => (
                        <div
                          key={chip}
                          style={{
                            fontFamily: bodyFamily,
                            fontWeight: 600,
                            fontSize: 28 * u,
                            padding: `${12 * u}px ${24 * u}px`,
                            borderRadius: 999,
                            backgroundColor:
                              c === all.length - 1 ? palette.accent : `color-mix(in srgb, ${g.ink} 9%, transparent)`,
                            color: c === all.length - 1 ? "#FFFFFF" : g.ink,
                          }}
                        >
                          {chip.trim()}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {tile.kind === "colour" ? (
                    <div
                      style={{
                        fontFamily: displayFamily,
                        fontWeight: 700,
                        fontSize: 44 * u,
                        letterSpacing: "-0.03em",
                        color: g.ink,
                      }}
                    >
                      {tile.text}
                    </div>
                  ) : null}
                  {tile.sub ? (
                    <div
                      style={{
                        position: "relative",
                        fontFamily: bodyFamily,
                        fontWeight: 500,
                        fontSize: 26 * u,
                        color: g.ink,
                        opacity: 0.6,
                        marginTop: 10 * u,
                      }}
                    >
                      {tile.sub}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </AbsoluteFill>
      </AbsoluteFill>
    </MaybeFinish>
  );
};

export const sceneBentoCollageDefaults: SceneBentoCollageProps = {
  styleId: "paper-signal",
  finish: true,
  tiles: [
    { kind: "word", text: "Apex", sub: "Launch films, directed", tone: "accent" },
    { kind: "stat", text: "4×", sub: "faster first cut", tone: "light" },
    { kind: "chips", text: "Draft, Review, Ship", sub: "", tone: "surface" },
    { kind: "stat", text: "12k", sub: "films rendered", tone: "light" },
    { kind: "colour", text: "Every frame on purpose.", sub: "", tone: "ink" },
    { kind: "stat", text: "−92%", sub: "review rounds", tone: "surface" },
    { kind: "word", text: "apex.studio", sub: "", tone: "light" },
  ],
  at: 4,
  steps: [8, 7, 6, 5, 4, 3],
  pushAt: 70,
  hero: 0,
};
