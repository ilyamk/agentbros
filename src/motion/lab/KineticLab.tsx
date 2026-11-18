import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont, cyrillicWideFont } from "../../lib/fonts-cyrillic";
import type { AudioMap, CueSheet } from "../../types/film";
import { LightPath, LivingLight, RadialField, ShockRing } from "../backgrounds";
import { flexFont } from "../fonts-flex";
import { FilmGrain } from "../fx";
import { hitDecay, hitShake, hitsDecay, type GridCell, type GridStep } from "../kinetic-math";
import {
  BuildingCaption,
  DollyStack,
  EchoWord,
  ElasticWord,
  GlyphRise,
  NumberRace,
  ScrambleWord,
  Slam,
  TypedLine,
} from "../kinetic-type";
import { CollageGrid, GrowToScene } from "../layout-morph";
import { audioPulse, cueFrame, energyAt, progress, track } from "../timing";
import { ScreenPlayback } from "../ui";
import { chalk, coal, ice, indigo, iris, night, pink } from "./kinetic-palette";

export const KINETIC_LAB_FRAMES = 450;

const FPS = 30;
const BEAT = 15;

/** A synthetic sheet at 120 BPM: the same shape `edit:snap` writes, so that swapping in a real one changes only this data. */
const CUE_FRAMES = {
  every: 30,
  frame: 60,
  code: 90,
  decode: 96,
  through: 118,
  dolly1: 120,
  dolly2: 150,
  dolly3: 180,
  grid: 210,
  grid2: 225,
  grid3: 240,
  grid4: 255,
  gridSlide: 270,
  gridTake: 285,
  type: 300,
  press: 342,
  takeover: 368,
  stretch: 375,
  stretch2: 405,
  done: 420,
} as const;

const cueSheet: Pick<CueSheet, "cues"> = {
  cues: Object.entries(CUE_FRAMES).map(([id, frame]) => ({
    id,
    kind: "hit" as const,
    intentSec: frame / FPS,
    snap: "beat" as const,
    snappedSec: frame / FPS,
    frame,
    deltaSec: 0,
  })),
};

const cue = (id: keyof typeof CUE_FRAMES): number => cueFrame(cueSheet, id);

const HIT_IDS = [
  "every",
  "frame",
  "code",
  "dolly1",
  "dolly2",
  "dolly3",
  "grid",
  "gridTake",
  "stretch",
  "done",
] as const;
const HITS = HIT_IDS.map(cue);

/** Synthetic audio map: kicks on the hits, hats on the beats between. This film is silent; only the data is exercised. */
const events: AudioMap["events"] = [
  ...HITS.map((frame) => ({ timeSec: frame / FPS, kind: "kick" as const, strength: 1, metric: "downbeat" as const })),
  ...Array.from({ length: 30 }, (_, n) => ({
    timeSec: (n * BEAT) / FPS,
    kind: "hat" as const,
    strength: 0.4,
    metric: "beat" as const,
  })),
];

const energyCurve: AudioMap["energyCurve"] = [
  [0, 0.04],
  [0.9, 0.22],
  [1.0, 0.8],
  [3.9, 0.55],
  [4.0, 0.9],
  [6.9, 0.5],
  [7.0, 0.35],
  [11.2, 0.3],
  [12.2, 0.75],
  [13.9, 0.6],
  [14.0, 1],
  [15, 0.7],
].map(([timeSec, rms]) => ({ timeSec: timeSec!, rms: rms!, low: rms!, high: rms! * 0.8 }));

const CAPTION = [
  { text: "Каждый", at: cue("every") },
  { text: "кадр", at: cue("frame") },
  { text: "это", at: cue("code") },
  { text: "код,", at: cue("decode") + 8 },
  { text: "сквозь", at: cue("dolly1") },
  { text: "слова,", at: cue("dolly2") },
  { text: "вглубь,", at: cue("dolly3") },
  { text: "в счёт,", at: cue("grid") },
  { text: "в кнопку,", at: cue("type") },
  { text: "и готово.", at: cue("done") },
];

const display = (fontSize: number, weight = 900): React.CSSProperties => ({
  fontFamily: cyrillicWideFont,
  fontWeight: weight,
  fontSize,
  lineHeight: 1,
});
const small = (fontSize: number, weight = 600): React.CSSProperties => ({
  fontFamily: cyrillicGroteskFont,
  fontWeight: weight,
  fontSize,
  lineHeight: 1.2,
});

const Centre: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", ...style }}>{children}</AbsoluteFill>
);

/** The first part: anticipation on a live field, then two slams and a scramble that the camera goes through. */
const Opening: React.FC<{ energy: number; hit: number }> = ({ energy, hit }) => {
  const frame = useCurrentFrame();
  const decodeEcho = frame >= cue("code");
  return (
    <AbsoluteFill>
      <LivingLight
        ground={night}
        lights={[indigo, "#1A1250"]}
        energy={energy}
        flash={hit * 0.5}
        flashColor={pink}
        vignette={0.75}
        vignetteColor={coal}
        seed="open"
      />
      <RadialField
        energy={Math.max(energy * 0.45, hitsDecay(frame, HITS, 16))}
        color={chalk}
        accent={ice}
        seed="open"
        clear={0.04}
      />
      <ShockRing hits={[cue("every"), cue("code")]} color={pink} />
      <Centre>
        <div
          style={{
            width: 8 + frame * 0.6,
            height: 8 + frame * 0.6,
            borderRadius: "50%",
            backgroundColor: ice,
            opacity: frame < cue("every") ? 1 : 0,
            boxShadow: `0 0 ${20 + frame * 2}px ${ice}`,
          }}
        />
      </Centre>
      {decodeEcho ? (
        <>
          <Centre style={{ top: -250 }}>
            <EchoWord text="ШИФР. ШИФР. ШИФР." drift={-1.6} color={iris} style={{ ...display(210), marginLeft: 120 }} />
          </Centre>
          <Centre style={{ top: 250 }}>
            <EchoWord text="ШИФР. ШИФР. ШИФР." drift={1.6} color={iris} style={{ ...display(210), marginLeft: -120 }} />
          </Centre>
        </>
      ) : null}
      <Centre>
        <Slam
          motion={{
            at: cue("every"),
            tilt: { y: -22, z: -6 },
            exitAt: cue("frame") - 5,
            exit: "left",
            exitFrames: 5,
            travel: 2600,
          }}
          color={chalk}
          glow={`0 0 36px ${pink}`}
          element="lab-word"
          style={display(240)}
        >
          КАЖДЫЙ
        </Slam>
      </Centre>
      {frame >= cue("frame") && frame < cue("code") ? (
        <Centre>
          <Sequence from={cue("frame")} layout="none">
            <GlyphRiseWord />
          </Sequence>
        </Centre>
      ) : null}
      <Centre>
        <Slam
          motion={{
            at: cue("code"),
            fromScale: 1.16,
            k: 0.75,
            creep: 0.03,
            exitAt: cue("through"),
            exit: "through",
            exitFrames: 3,
          }}
          color={pink}
          element="lab-word"
          halfWidth={520}
          style={{}}
        >
          <ScrambleWord
            text="ШИФР."
            at={cue("decode")}
            duration={18}
            seed="lab"
            chroma={9}
            chromaColours={[ice, iris]}
            style={display(260)}
          />
        </Slam>
      </Centre>
    </AbsoluteFill>
  );
};

const GlyphRiseWord: React.FC = () => {
  const frame = useCurrentFrame();
  const leave = track(frame, [
    { at: 22, value: 0 },
    { at: 30, value: -900, curve: "expoIn" },
  ]);
  return (
    <div style={{ transform: `translateY(${leave}px)` }}>
      <GlyphRise
        text="КАДР"
        at={0}
        step={1.6}
        frames={6}
        seed="lab-frame"
        element="lab-word"
        style={{ ...display(320), color: chalk }}
      />
    </div>
  );
};

const DOLLY_WORDS = [
  { text: "СКВОЗЬ", at: cue("dolly1"), tilt: -5, color: coal },
  { text: "СЛОВА", at: cue("dolly2"), tilt: 4, color: indigo },
  { text: "ВГЛУБЬ", at: cue("dolly3"), tilt: -3, color: coal },
  { text: "СЧЁТ", at: cue("grid") + 12, tilt: 2, color: indigo },
];

/** Depth on a light ground: words at distances, the light and a thin comet behind them. */
const Depth: React.FC<{ energy: number; hit: number }> = ({ energy, hit }) => (
  <AbsoluteFill>
    <LivingLight
      ground={chalk}
      lights={["#FFFFFF", "#D5CFFF", "#FFD3E4"]}
      energy={energy}
      flash={hit * 0.55}
      flashColor="#FFFFFF"
      vignette={0.65}
      vignetteColor="#6E68A8"
      seed="depth"
    />
    <RadialField energy={0.1 + hit * 0.5} color={indigo} seed="depth" clear={0.25} />
    <LightPath
      d="M -40 900 C 500 960 1100 300 1960 180"
      at={cue("dolly2") - 10}
      frames={22}
      color={pink}
      strokeWidth={2.5}
      fadeFrames={18}
    />
    <DollyStack words={DOLLY_WORDS} rectColor={pink} style={display(180)} />
  </AbsoluteFill>
);

const GRID_STEPS: GridStep[] = [
  { at: cue("grid"), cell: "root", dir: "x", ratio: 0.42, into: ["left", "right"] },
  { at: cue("grid2"), cell: "right", dir: "y", ratio: 0.32, into: ["tag", "main"] },
  { at: cue("grid3"), cell: "left", dir: "y", ratio: 0.58, into: ["glow", "count"] },
  { at: cue("grid4"), cell: "main", dir: "x", ratio: 0.58, into: ["word", "tile"] },
  { at: cue("gridSlide"), cell: "root", ratio: 0.62 },
  { at: cue("gridTake"), cell: "root", ratio: 0 },
  { at: cue("gridTake"), cell: "right", ratio: 0 },
  { at: cue("gridTake"), cell: "main", ratio: 1 },
];

const Cell: React.FC<{ cell: GridCell }> = ({ cell }) => {
  const frame = useCurrentFrame();
  if (cell.id === "count")
    return (
      <AbsoluteFill style={{ backgroundColor: coal, alignItems: "center", justifyContent: "center", color: pink }}>
        <NumberRace
          size={118}
          at={cue("grid3") + 2}
          frames={50}
          to={3108}
          style={{ fontFamily: cyrillicWideFont, fontWeight: 800 }}
          element="lab-race"
        />
      </AbsoluteFill>
    );
  if (cell.id === "tag")
    return (
      <AbsoluteFill
        style={{
          backgroundColor: pink,
          justifyContent: "flex-end",
          padding: "0 0 30px 36px",
          ...display(76),
          color: coal,
          whiteSpace: "pre",
        }}
      >
        {cell.height > 130 && frame < cue("gridTake") ? "СЧЁТ" : ""}
      </AbsoluteFill>
    );
  if (cell.id === "word" || cell.id === "main")
    return (
      <AbsoluteFill style={{ backgroundColor: chalk, alignItems: "center", justifyContent: "center" }}>
        <ElasticWord
          text="ДЕЛИТСЯ"
          keys={[
            { at: cue("grid4"), wdth: 30, wght: 900 },
            { at: cue("grid4") + 6, wdth: 125 },
            { at: cue("gridSlide"), wdth: 80, wght: 300 },
            { at: cue("gridTake"), wdth: 128, wght: 1000 },
          ]}
          fontFamily={flexFont}
          style={{ fontSize: 112, color: indigo, lineHeight: 1 }}
        />
      </AbsoluteFill>
    );
  if (cell.id === "tile") return <ScreenPlayback kind="image" src="motion-lab/studio.png" position="30% 20%" />;
  const shift = cell.id.length;
  return (
    <AbsoluteFill style={{ backgroundColor: cell.id === "tile" ? indigo : night, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: `${50 + 40 * Math.sin(frame * 0.05 + shift)}%`,
          top: `${50 + 34 * Math.cos(frame * 0.04 + shift * 2)}%`,
          width: 1000,
          height: 1000,
          marginLeft: -500,
          marginTop: -500,
          background: `radial-gradient(circle, ${ice}B0 0%, ${iris}66 32%, transparent 64%)`,
        }}
      />
    </AbsoluteFill>
  );
};

const BUTTON = { x: 510, y: 660, width: 900, height: 170, radius: 36 };

/** A brief is typed; the button under it takes the whole frame. */
const Press: React.FC<{ hit: number }> = ({ hit }) => {
  const stage = { width: 1920, height: 1080 };
  const form = (
    <AbsoluteFill>
      <LivingLight ground={coal} lights={["#171246", indigo]} energy={0.25} vignette={0.6} seed="press" />
      <RadialField energy={0.12} color={iris} seed="press" clear={0.3} />
      <Centre style={{ top: -390 }}>
        <EchoWord text="СКОРОСТЬ СКОРОСТЬ" drift={-1.2} color={iris} style={{ ...display(200), marginLeft: 260 }} />
      </Centre>
      <Centre style={{ top: -130 }}>
        <TypedLine
          text="Ролик про скорость, 15 секунд"
          at={cue("type") + 2}
          seed="lab"
          pace={1.05}
          highlights={[{ text: "скорость", at: cue("press") - 12, slant: true }]}
          highlightColor="rgba(255,47,126,0.55)"
          box
          boxColor={ice}
          boxFill="rgba(255,255,255,0.05)"
          caretColor={pink}
          style={{ ...small(82), color: chalk }}
        />
      </Centre>
    </AbsoluteFill>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: coal, opacity: 1 }}>
      <GrowToScene
        from={BUTTON}
        stage={stage}
        surface={`linear-gradient(115deg, ${iris}, ${pink})`}
        ground={pink}
        at={cue("press")}
        frames={cue("takeover") - cue("press")}
        behind={form}
      >
        <span style={{ ...small(72), color: chalk }}>Собрать ролик</span>
      </GrowToScene>
      {hit > 0 ? <AbsoluteFill style={{ backgroundColor: "#FFFFFF", opacity: hit * 0.3 }} /> : null}
    </AbsoluteFill>
  );
};

/** The takeover's colour is the ground here. A width stretch, then the last word lands and stays. */
const Ending: React.FC<{ energy: number; hit: number }> = ({ energy, hit }) => {
  const frame = useCurrentFrame();
  const showStretch = frame >= cue("stretch") && frame < cue("done");
  // The takeover ends on flat pink, so the light opens up from there instead of popping in.
  const lightUp = progress(frame, cue("takeover"), 16, "drift");
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ backgroundColor: pink }} />
      <AbsoluteFill style={{ opacity: lightUp }}>
        <LivingLight
          ground={pink}
          lights={["#FF80AE", "#B90F50"]}
          energy={energy}
          flash={hit * 0.6}
          flashColor="#FFFFFF"
          vignette={0.6}
          vignetteColor="#4E0627"
          seed="end"
        />
      </AbsoluteFill>
      <RadialField energy={Math.max(0.1, hitDecay(frame, cue("done"), 24))} color={coal} seed="end" clear={0.18} />
      <ShockRing hits={[cue("done")]} color={coal} />
      {frame >= cue("done") ? (
        <>
          <Centre style={{ top: -300 }}>
            <EchoWord
              text="ГОТОВО ГОТОВО ГОТОВО"
              drift={-1.1}
              color={coal}
              opacity={0.22}
              style={{ ...display(230), marginLeft: 240 }}
            />
          </Centre>
          <Centre style={{ top: 300 }}>
            <EchoWord
              text="ГОТОВО ГОТОВО ГОТОВО"
              drift={1.1}
              color={coal}
              opacity={0.22}
              style={{ ...display(230), marginLeft: -240 }}
            />
          </Centre>
        </>
      ) : null}
      {showStretch ? (
        <Centre>
          <ElasticWord
            text="РЕЗИНА"
            keys={[
              { at: cue("stretch"), wdth: 25, wght: 1000 },
              { at: cue("stretch") + 4, wdth: 128 },
              { at: cue("stretch2"), wght: 150 },
            ]}
            fontFamily={flexFont}
            element="lab-word"
            style={{ fontSize: 310, lineHeight: 1, color: coal }}
          />
        </Centre>
      ) : null}
      <Centre>
        <Slam
          motion={{ at: cue("done"), tilt: { y: 22, z: 5 }, creep: 0.03 }}
          color={coal}
          element="lab-word"
          style={display(270)}
        >
          ГОТОВО
        </Slam>
      </Centre>
    </AbsoluteFill>
  );
};

/** Proof that the vocabulary stacks: foreground type, a mid layer, a live ground and small persistent details on every frame, all locked to one cue sheet. */
export const KineticLab: React.FC = () => {
  const frame = useCurrentFrame();
  const energy = energyAt(frame, FPS, energyCurve);
  const hit = hitsDecay(frame, HITS, 6);
  const kick = audioPulse(frame, FPS, events, { kinds: ["kick"], frames: 7 });
  const latest = [...HITS].reverse().find((at) => frame >= at) ?? HITS[0]!;
  const shake = hitShake(frame, latest, { seed: "lab", amplitude: 9 });
  const inDepth = frame >= cue("dolly1") && frame < cue("grid");
  const inEnd = frame >= cue("takeover");
  const lightGround = inDepth || inEnd;
  return (
    <AbsoluteFill style={{ backgroundColor: coal, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translate(${shake.x}px, ${shake.y}px) rotate(${shake.roll}deg) scale(${1 + kick * 0.012})`,
        }}
      >
        {frame < cue("dolly1") ? <Opening energy={energy} hit={hit} /> : null}
        {inDepth ? <Depth energy={energy} hit={hit} /> : null}
        {frame >= cue("grid") && frame < cue("type") ? (
          <AbsoluteFill style={{ backgroundColor: coal }}>
            <CollageGrid
              steps={GRID_STEPS}
              stage={{ width: 1920, height: 1080 }}
              gutter={14}
              ground={coal}
              frames={13}
              cell={(cell) => <Cell cell={cell} />}
            />
          </AbsoluteFill>
        ) : null}
        {frame >= cue("type") && frame < cue("takeover") ? <Press hit={hit} /> : null}
        {inEnd ? <Ending energy={energy} hit={hit} /> : null}
      </AbsoluteFill>
      <FilmGrain seed="lab" opacity={0.1} />
      {/* The small persistent detail survives every cut and takes the ground's colours. */}
      <AbsoluteFill style={{ padding: "44px 56px" }}>
        <BuildingCaption
          words={CAPTION}
          color={lightGround ? coal : chalk}
          tagColor={inEnd ? coal : pink}
          tagTextColor={inEnd ? chalk : coal}
          style={small(30, 700)}
        />
      </AbsoluteFill>
      <div
        data-element="lab-counter"
        style={{
          position: "absolute",
          right: 56,
          top: 48,
          ...small(22),
          color: lightGround ? coal : chalk,
          opacity: 0.7,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "pre",
        }}
      >
        {`кадр ${String(frame).padStart(3, "0")} / ${KINETIC_LAB_FRAMES}`}
      </div>
      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          bottom: 40,
          height: 2,
          backgroundColor: lightGround ? coal : chalk,
          opacity: 0.25,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 56,
          bottom: 40,
          height: 2,
          width: ((1920 - 112) * frame) / (KINETIC_LAB_FRAMES - 1),
          backgroundColor: lightGround ? coal : pink,
        }}
      />
    </AbsoluteFill>
  );
};
