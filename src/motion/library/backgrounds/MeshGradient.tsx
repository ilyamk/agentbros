import { noise2D } from "@remotion/noise";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";
import { audioReactSchema, curveIntegral, useAudioReact } from "../../sync/curves";

export const meshGradientSchema = z.object({
  base: z.string(),
  colours: z.array(z.string()).min(2).max(7),
  /** Drift speed; 1 crosses a third of the frame in about four seconds. */
  speed: z.number().min(0).max(4),
  /** Blob size as a share of the long side. */
  size: z.number().min(0.2).max(1.2),
  /** "screen" for dark grounds (blobs add light), "normal" for light grounds. */
  blend: z.enum(["screen", "normal", "multiply"]),
  grain: z.number().min(0).max(0.5),
  seed: z.string(),
  /** Off unless set: the drift speeds up with the bass and the hue leans with it, from an AudioCurvesProvider above. `curve` defaults to the bass stem, else the low band; `amount` (extra speed at full bass, up to 2) to 0.8; `hue` (degrees at full bass) to 6. Smoothed over 6 frames. */
  react: audioReactSchema(2)
    .extend({ hue: z.number().min(0).max(30).optional() })
    .optional(),
});

export type MeshGradientProps = z.infer<typeof meshGradientSchema>;

/** Soft colour fields drifting and overlapping, Stripe-style. A ground that is never flat. */
export const MeshGradient: React.FC<MeshGradientProps> = ({
  base,
  colours,
  speed,
  size,
  blend,
  grain,
  seed,
  react,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const long = Math.max(width, height);
  const audio = useAudioReact(react, ["bass", "low"], 6);
  // Bass adds to the speed through its running sum, so time never runs backwards when the bass drops.
  const read = audio ? { offsetFrames: audio.offsetFrames, smooth: audio.smooth } : {};
  const extra = audio
    ? (audio.amount ?? 0.8) *
      (curveIntegral(audio.curves, audio.name, frame, read) - curveIntegral(audio.curves, audio.name, 0, read))
    : 0;
  const t = ((frame + extra) / 120) * speed;
  const hue = audio ? (react?.hue ?? 6) * audio.value : 0;
  return (
    <AbsoluteFill
      style={{ backgroundColor: base, overflow: "hidden", ...(audio ? { filter: `hue-rotate(${hue}deg)` } : {}) }}
    >
      {colours.map((colour, i) => {
        const home = { x: 0.15 + 0.7 * ((i * 0.618) % 1), y: 0.2 + 0.6 * ((i * 0.382 + 0.3) % 1) };
        const x = (home.x + 0.28 * noise2D(`${seed}-x${i}`, t, i * 3.1)) * width;
        const y = (home.y + 0.28 * noise2D(`${seed}-y${i}`, i * 2.3, t)) * height;
        const r = long * size * (0.85 + 0.25 * noise2D(`${seed}-r${i}`, t * 0.7, i));
        return (
          <div
            key={`${colour}-${i}`}
            style={{
              position: "absolute",
              left: x - r,
              top: y - r,
              width: r * 2,
              height: r * 2,
              mixBlendMode: i === 0 ? "normal" : blend,
              background: `radial-gradient(circle at 50% 50%, ${colour} 0%, color-mix(in srgb, ${colour} 55%, transparent) 30%, color-mix(in srgb, ${colour} 18%, transparent) 55%, transparent 72%)`,
            }}
          />
        );
      })}
      {grain > 0 ? <FilmGrain seed={seed} opacity={grain} frequency={0.85} /> : null}
    </AbsoluteFill>
  );
};
