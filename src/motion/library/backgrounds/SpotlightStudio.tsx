import { noise2D } from "@remotion/noise";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";
import { CASHFREE_PULL_BACK, pullBackScale, tintedSweep } from "./background-plan";

export type SpotlightStudioSettings = {
  ground: string;
  light: string;
  /** Floor line as a share of the frame height. */
  floor?: number;
  intensity?: number;
  seed?: string;
  /**
   * Brand-colour studio (cashfree): the sweep lit and tinted in this colour, pale at the top to a deep shade on the floor,
   * instead of dark. Replaces `ground` for the sweep; `light` still colours the key and the pool.
   */
  tint?: string;
  /** Pull the product back from filling the frame to rest: scale 1/`to` to 1 over `frames` from `at`, power3.out (cashfree: 0.47, 14 f). */
  pullBack?: { at: number; frames?: number; to?: number };
};

/**
 * A dark studio with one soft key light from above, a pool on the floor and a seamless cyc. Place a product in
 * `children`; it stands on the floor line and gets a soft reflection when `reflection` is on (children render twice,
 * so keep audio and video out).
 */
export const SpotlightStudio: React.FC<
  SpotlightStudioSettings & { children?: React.ReactNode; reflection?: boolean }
> = ({ ground, light, floor = 0.68, intensity = 1, seed = "studio", tint, pullBack, children, reflection = true }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const t = frame / 90;
  const sway = 3 * noise2D(`${seed}-sway`, t, 0);
  const breathe = Math.min(1.8, intensity * (0.9 + 0.1 * noise2D(`${seed}-b`, t * 0.6, 4)));
  const fy = height * floor;
  const sweep = tint ? tintedSweep(tint) : null;
  const scale = pullBack
    ? pullBackScale(frame, {
        at: pullBack.at,
        frames: pullBack.frames ?? CASHFREE_PULL_BACK.frames,
        to: pullBack.to ?? CASHFREE_PULL_BACK.to,
      })
    : 1;
  const product =
    scale === 1 ? (
      children
    ) : (
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `50% ${floor * 100 - 10}%` }}>
        {children}
      </AbsoluteFill>
    );
  return (
    <AbsoluteFill style={{ backgroundColor: sweep?.wall ?? ground, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background: sweep
            ? `linear-gradient(180deg, ${sweep.top} 0%, ${sweep.wall} ${floor * 100 - 14}%, color-mix(in srgb, ${sweep.wall} 55%, ${sweep.floor}) ${floor * 100}%, ${sweep.floor} ${floor * 100 + 16}%, ${sweep.edge} 100%)`
            : `linear-gradient(180deg, color-mix(in srgb, black 35%, ${ground}) 0%, ${ground} ${floor * 100 - 8}%, color-mix(in srgb, ${light} 6%, ${ground}) ${floor * 100}%, color-mix(in srgb, black 45%, ${ground}) 100%)`,
        }}
      />
      <AbsoluteFill
        style={{
          mixBlendMode: "screen",
          background: [
            `radial-gradient(ellipse ${width * 0.34}px ${height * 0.75}px at ${50 + sway}% -6%, color-mix(in srgb, ${light} ${34 * breathe}%, transparent) 0%, color-mix(in srgb, ${light} ${12 * breathe}%, transparent) 45%, transparent 100%)`,
            `radial-gradient(ellipse ${width * 0.3}px ${height * 0.07}px at 50% ${fy}px, color-mix(in srgb, ${light} ${Math.min(100, 55 * breathe)}%, transparent) 0%, color-mix(in srgb, ${light} ${14 * breathe}%, transparent) 55%, transparent 100%)`,
            `radial-gradient(ellipse ${width * 0.6}px ${height * 0.22}px at 50% ${fy}px, color-mix(in srgb, ${light} ${12 * breathe}%, transparent) 0%, transparent 100%)`,
          ].join(", "),
        }}
      />
      {children ? (
        <>
          {reflection ? (
            <AbsoluteFill
              style={{
                transform: `translateY(${fy * 2 - height}px) scaleY(-1)`,
                opacity: 0.3,
                filter: `blur(${width * 0.002}px)`,
                maskImage: `linear-gradient(180deg, transparent ${floor * 100 - 22}%, black ${floor * 100}%)`,
                WebkitMaskImage: `linear-gradient(180deg, transparent ${floor * 100 - 22}%, black ${floor * 100}%)`,
              }}
            >
              {product}
            </AbsoluteFill>
          ) : null}
          <AbsoluteFill>{product}</AbsoluteFill>
        </>
      ) : null}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 80% 80% at 50% 45%, transparent 40%, rgba(0,0,0,${sweep ? 0.25 : 0.6}) 110%)`,
        }}
      />
      <FilmGrain seed={seed} opacity={0.1} />
    </AbsoluteFill>
  );
};

export const spotlightStudioSchema = z.object({
  ground: z.string(),
  light: z.string(),
  floor: z.number().min(0.3).max(0.95),
  intensity: z.number().min(0).max(2),
  seed: z.string(),
  demo: z.boolean(),
  /** Brand colour for a tinted sweep; omit for the dark studio. */
  tint: z.string().optional(),
  pullBack: z
    .object({
      at: z.number().int().min(0),
      frames: z.number().int().min(1).optional(),
      to: z.number().min(0.1).max(1).optional(),
    })
    .optional(),
});

export type SpotlightStudioPreviewProps = z.infer<typeof spotlightStudioSchema>;

const DemoObject: React.FC<{ floor: number }> = ({ floor }) => {
  const { width, height } = useVideoConfig();
  const r = Math.min(width, height) * 0.13;
  const cy = height * floor - r;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: width / 2 - r * 0.9,
          top: cy + r - r * 0.06,
          width: r * 1.8,
          height: r * 0.14,
          borderRadius: "50%",
          background: "radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 45%, transparent 75%)",
          filter: `blur(${r * 0.04}px)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: width / 2 - r,
          top: cy - r,
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          background:
            "radial-gradient(circle at 50% 22%, #ffffff 0%, #d9dde6 10%, #6b7280 45%, #1f2329 80%, #0b0c0f 100%)",
          boxShadow: `0 ${r * 0.08}px ${r * 0.3}px rgba(0,0,0,0.6)`,
        }}
      />
    </>
  );
};

export const SpotlightStudioPreview: React.FC<SpotlightStudioPreviewProps> = ({ demo, ...settings }) => (
  <SpotlightStudio {...settings}>{demo ? <DemoObject floor={settings.floor} /> : null}</SpotlightStudio>
);
