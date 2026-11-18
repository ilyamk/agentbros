import React from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";
import { MediaPlate } from "../effects/plates";
import { PlaceholderTile } from "../ui/PlaceholderResolve";
import { resolveState } from "../ui/ui-plan";
import {
  WALL_CURVE,
  WALL_RESOLVE_FRAMES,
  WALL_SCROLL,
  WALL_VIGNETTE,
  wallCurve,
  wallPlan,
  wallScrollY,
  wallTiles,
} from "./camera-plan";
import { PopulatePullOut, PopulatePullOutPreview, type PopulatePullOutProps } from "./PopulatePullOut";

/**
 * populate-pull-out `variant: "wall"` (ugc-app person-wall): the wall of clips the camera pulls back from. Kept apart
 * from PopulatePullOut.tsx so its pure pose functions stay importable in node tests without the media packages.
 */

/** A drawn stand-in for a person's clip: a seeded ground, head and shoulders that bob slowly. Unbranded, no face. */
const PersonStandIn: React.FC<{ seed: number }> = ({ seed }) => {
  const frame = useCurrentFrame();
  const hue = Math.floor(random(`wall-hue-${seed}`) * 360);
  const skin = ["#F1D3BC", "#D9A27E", "#A86F4C", "#6B4430", "#E8C2A0"][seed % 5];
  const bob = Math.sin((frame + seed * 7) / 9) * 2;
  return (
    <svg
      viewBox="0 0 90 160"
      preserveAspectRatio="xMidYMid slice"
      style={{ width: "100%", height: "100%", display: "block" }}
    >
      <rect width="90" height="160" fill={`hsl(${hue} 28% 78%)`} />
      <rect y="110" width="90" height="50" fill={`hsl(${hue} 22% 64%)`} />
      <g transform={`translate(0 ${bob})`}>
        <path d="M14 160 Q16 108 45 104 Q74 108 76 160Z" fill={`hsl(${(hue + 150) % 360} 35% 42%)`} />
        <circle cx="45" cy="80" r="19" fill={skin} />
        <path d="M26 78 Q28 56 45 57 Q62 56 64 78 Q58 66 45 66 Q32 66 26 78Z" fill="#2B211C" />
      </g>
    </svg>
  );
};

/**
 * A wall of clips in `cols` x `rows` tiles at frame size: soft white blocks appear ring by ring outward from the centre
 * from `start` and un-blur into their clips over about 8 frames (placeholder-resolve's white tiles, `wallPlan` in
 * camera-plan.ts). Clips go through `<Video>` from @remotion/media (muted); pass low-resolution proxies, a wall decodes
 * every tile at once. Wrap it in `<PopulatePullOut variant="wall">`.
 */
export const VideoWall: React.FC<{
  cols: number;
  rows: number;
  clips?: string[];
  start: number;
  step?: number;
  dissolve?: number;
  stagger?: number;
  ground?: string;
  scroll?: number;
  curve?: number;
}> = ({
  cols,
  rows,
  clips = [],
  start,
  step = 1,
  dissolve = WALL_RESOLVE_FRAMES,
  stagger = 0.5,
  ground = "#0B0B0C",
  scroll = 0,
  curve = 0,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // A scrolling column needs a spare tile to wrap into, as the staggered one already has.
  const tiles = wallTiles(cols, rows, 0.06, scroll > 0 && stagger <= 0 ? 1e-6 : stagger);
  const plan = wallPlan(tiles, cols, start, step, dissolve);
  const perColumn = tiles.length / cols;
  return (
    <AbsoluteFill style={{ backgroundColor: ground }}>
      {tiles.map((t, i) => {
        const st = resolveState(frame, plan[i]!);
        if (!st.shown) return null;
        // `scroll`: each column an endless feed, neighbours in opposite directions; `curve`: the wall bowed on a cylinder.
        const y = wallScrollY(t.y, i % cols, frame, scroll, 1 / rows, perColumn);
        const bent = wallCurve(t.x + t.w / 2, curve);
        const w = t.w * bent.scaleX;
        const h = t.h * bent.scaleY;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: (bent.cx - w / 2) * width,
              top: (y + (t.h - h) / 2) * height,
              width: w * width,
              height: h * height,
              borderRadius: 0.06 * w * width,
              overflow: "hidden",
            }}
          >
            <PlaceholderTile
              kind="white"
              resolve={st.resolve}
              frame={frame}
              colours={["#FFFFFF", "#FFFFFF"]}
              blur={Math.max(4, 0.12 * t.w * width)}
            >
              {clips.length > 0 ? <MediaPlate src={clips[i % clips.length]!} /> : <PersonStandIn seed={i} />}
            </PlaceholderTile>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** Library preview of populate-pull-out: the week board, or with `variant: "wall"` a wall of stand-in clips. */
export const PopulatePullOutLibraryPreview: React.FC<PopulatePullOutProps> = (props) => {
  if (props.variant !== "wall") return <PopulatePullOutPreview {...props} />;
  const {
    events: _events,
    every: _every,
    dropFrom,
    wallCols,
    wallRows,
    clips,
    wallScroll,
    wallCurve: curve,
    wallVignette,
    ...plan
  } = props;
  return (
    <AbsoluteFill>
      <PopulatePullOut {...plan} ground="#0B0B0C">
        <VideoWall
          cols={wallCols ?? 16}
          rows={wallRows ?? 5}
          clips={clips}
          start={dropFrom}
          scroll={wallScroll}
          curve={curve}
        />
      </PopulatePullOut>
      {wallVignette ? <WallVignette strength={wallVignette} /> : null}
    </AbsoluteFill>
  );
};

/**
 * A frame-fixed vignette for the wall, laid over `<PopulatePullOut>` (not inside it, so it does not scale with the
 * pull): the outer columns darken towards the corners and go soft (ugc-app F190: edges about half as bright, blurred).
 */
export const WallVignette: React.FC<{ strength?: number }> = ({ strength = WALL_VIGNETTE }) => {
  const { width, height } = useVideoConfig();
  const soft = `radial-gradient(ellipse 75% 85% at 50% 50%, transparent 45%, black 95%)`;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          backdropFilter: `blur(${Math.round(0.006 * Math.max(width, height) * strength * 1.6)}px)`,
          WebkitBackdropFilter: `blur(${Math.round(0.006 * Math.max(width, height) * strength * 1.6)}px)`,
          maskImage: soft,
          WebkitMaskImage: soft,
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 75% 85% at 50% 50%, rgba(0,0,0,0) 35%, rgba(0,0,0,${strength}) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** ugc-app's wall as previewed: the wall variant with its column scroll, bow and vignette on, stand-in clips. */
export const populatePullOutWallPreset = {
  variant: "wall" as const,
  closeScale: 3.2,
  midScale: 2.2,
  pullAt: 30,
  pullFrames: 15,
  secondFrames: 51,
  dropFrom: 4,
  wallCols: 16,
  wallRows: 5,
  wallScroll: WALL_SCROLL,
  wallCurve: WALL_CURVE,
  wallVignette: WALL_VIGNETTE,
};
