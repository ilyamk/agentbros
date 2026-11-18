import { loadFont } from "@remotion/google-fonts/Inter";
import { noise2D } from "@remotion/noise";
import React, { useId } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";
import { resolveFinish, type FilmFinishSettings, type FinishPresetName } from "./presets";
import { TextureOverlay } from "./TextureOverlay";

export type { FilmFinishSettings } from "./presets";

type FilmFinishProps = FilmFinishSettings & {
  /** A named look (`clean`, `filmic`, `tactile`); explicit props override it. With no preset and no props: grain 0.04 only. */
  preset?: FinishPresetName;
  children: React.ReactNode;
};

const BloomFilter: React.FC<{ id: string; strength: number; threshold: number; radius: number }> = ({
  id,
  strength,
  threshold,
  radius,
}) => {
  const gain = 1 / Math.max(1 - threshold, 0.05);
  const cut = threshold * gain;
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix
          in="SourceGraphic"
          type="matrix"
          values={`${gain} 0 0 0 ${-cut}  0 ${gain} 0 0 ${-cut}  0 0 ${gain} 0 ${-cut}  0 0 0 1 0`}
          result="hi"
        />
        <feGaussianBlur in="hi" stdDeviation={radius} result="glow" />
        <feComposite in="SourceGraphic" in2="glow" operator="arithmetic" k1={0} k2={1} k3={strength} k4={0} />
      </filter>
    </svg>
  );
};

const AberrationFilter: React.FC<{ id: string; offset: number }> = ({ id, offset }) => (
  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
    <filter id={id} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feOffset in="r" dx={-offset} dy={-offset * 0.35} result="rs" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
      <feOffset in="b" dx={offset} dy={offset * 0.35} result="bs" />
      <feBlend in="rs" in2="g" mode="screen" result="rg" />
      <feBlend in="rg" in2="bs" mode="screen" />
    </filter>
  </svg>
);

/** Warm light pouring in from the left edge; drifts and breathes on seeded noise. */
export const LightLeakLayer: React.FC<{ intensity: number; colour: string; seed: string }> = ({
  intensity,
  colour,
  seed,
}) => {
  const frame = useCurrentFrame();
  const t = frame / 90;
  const swell = 0.65 + 0.35 * noise2D(`${seed}-swell`, t, 0);
  const y = 30 + 25 * noise2D(`${seed}-y`, t * 0.6, 3);
  const y2 = 70 + 20 * noise2D(`${seed}-y2`, t * 0.5, 7);
  const a = intensity * swell;
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        mixBlendMode: "screen",
        background: [
          `radial-gradient(ellipse 38% 70% at -6% ${y}%, color-mix(in srgb, ${colour} ${a * 95}%, transparent) 0%, transparent 70%)`,
          `radial-gradient(ellipse 22% 45% at 2% ${y2}%, color-mix(in srgb, #ff4f6d ${a * 55}%, transparent) 0%, transparent 70%)`,
          `radial-gradient(ellipse 60% 30% at 0% ${y}%, color-mix(in srgb, #fff3d6 ${a * 35}%, transparent) 0%, transparent 60%)`,
        ].join(", "),
      }}
    />
  );
};

/**
 * The one finish layer of a film. By default only a fine grain (0.04) that stops flat grounds banding; breathing
 * camera, bloom, edge colour fringes, light leak and vignette are opt-in, because they read as stock. Wrap a whole film once. With `aberration` above 0 the children render twice, so keep
 * `<Audio>` and `<OffthreadVideo>` outside this wrapper (or set `aberration={0}`).
 */
export const FilmFinish: React.FC<FilmFinishProps> = ({ children, preset, ...explicit }) => {
  const {
    grain,
    vignette,
    bloom,
    bloomThreshold,
    aberration,
    lightLeak,
    lightLeakColour,
    drift,
    seed,
    texture,
    textureOpacity,
  } = resolveFinish(preset, explicit);
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const ids = useId().replaceAll(":", "");
  const bloomId = `bloom-${ids}`;
  const caId = `ca-${ids}`;
  const t = frame / 75;
  const scale = 1 + drift * (0.018 + 0.006 * Math.sin(frame / 48));
  const dx = drift * width * 0.004 * noise2D(`${seed}-dx`, t, 0);
  const dy = drift * width * 0.003 * noise2D(`${seed}-dy`, 0, t);
  const roll = drift * 0.12 * noise2D(`${seed}-roll`, t * 0.7, 2);
  const camera = drift > 0 ? `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${roll}deg)` : undefined;
  const plate = (
    <AbsoluteFill style={{ transform: camera, filter: bloom > 0 ? `url(#${bloomId})` : undefined }}>
      {children}
    </AbsoluteFill>
  );
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#000" }}>
      {bloom > 0 ? (
        <BloomFilter id={bloomId} strength={bloom * 1.6} threshold={bloomThreshold} radius={width * 0.018} />
      ) : null}
      {plate}
      {aberration > 0 ? (
        <>
          <AberrationFilter id={caId} offset={aberration} />
          <AbsoluteFill
            style={{
              filter: `url(#${caId})`,
              maskImage: "radial-gradient(ellipse 75% 75% at 50% 50%, transparent 55%, black 100%)",
              WebkitMaskImage: "radial-gradient(ellipse 75% 75% at 50% 50%, transparent 55%, black 100%)",
            }}
          >
            {plate}
          </AbsoluteFill>
        </>
      ) : null}
      {lightLeak > 0 ? <LightLeakLayer intensity={lightLeak} colour={lightLeakColour} seed={seed} /> : null}
      {texture !== "none" && textureOpacity > 0 ? (
        <TextureOverlay kind={texture} opacity={textureOpacity} seed={seed} />
      ) : null}
      {vignette > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: `radial-gradient(ellipse 85% 85% at 50% 48%, transparent 55%, rgba(0,0,0,${vignette}) 100%)`,
          }}
        />
      ) : null}
      {grain > 0 ? <FilmGrain seed={seed} opacity={grain} cadence={2} frequency={0.78} /> : null}
    </AbsoluteFill>
  );
};

export const filmFinishSchema = z.object({
  /** "none" renders the settings below; a named look renders that preset as it ships (the settings are the no-preset look, and would override it). */
  preset: z.enum(["none", "clean", "filmic", "tactile"]),
  grain: z.number().min(0).max(0.5),
  vignette: z.number().min(0).max(1),
  bloom: z.number().min(0).max(1),
  bloomThreshold: z.number().min(0).max(0.95),
  aberration: z.number().min(0).max(12),
  lightLeak: z.number().min(0).max(1),
  lightLeakColour: z.string(),
  drift: z.number().min(0).max(1),
  seed: z.string(),
  demo: z.boolean(),
  headline: z.string(),
});

export type FilmFinishPreviewProps = z.infer<typeof filmFinishSchema>;

const { fontFamily: demoFont } = loadFont("normal", { weights: ["700"], subsets: ["latin"] });

const DemoPlate: React.FC<{ headline: string }> = ({ headline }) => {
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height);
  const vertical = height > width;
  // Half paper, half ink: the grain has to hold on both, and nothing else should be visible.
  return (
    <AbsoluteFill
      style={{
        background: vertical
          ? "linear-gradient(180deg, #F3F2EE 50%, #141414 50%)"
          : "linear-gradient(90deg, #F3F2EE 50%, #141414 50%)",
      }}
    >
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            fontFamily: demoFont,
            fontWeight: 700,
            fontSize: unit * 0.16,
            letterSpacing: "-0.05em",
            color: "#F2541B",
            textAlign: "center",
            lineHeight: 1,
          }}
        >
          {headline}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Library preview: `FilmFinish` over a sample plate when `demo` is on. */
export const FilmFinishPreview: React.FC<FilmFinishPreviewProps> = ({ demo, headline, preset, ...settings }) => {
  const plate = demo ? <DemoPlate headline={headline} /> : <AbsoluteFill style={{ backgroundColor: "#111" }} />;
  return preset === "none" ? (
    <FilmFinish {...settings}>{plate}</FilmFinish>
  ) : (
    <FilmFinish preset={preset} seed={settings.seed}>
      {plate}
    </FilmFinish>
  );
};
