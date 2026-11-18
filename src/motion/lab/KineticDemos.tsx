import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont, cyrillicWideFont } from "../../lib/fonts-cyrillic";
import { LightPath, LivingLight, RadialField, ShockRing } from "../backgrounds";
import { flexFont } from "../fonts-flex";
import { FilmGrain } from "../fx";
import { elasticAxes, hitDecay, hitShake, hitsDecay, settle, type GridCell } from "../kinetic-math";
import {
  BuildingCaption,
  DollyStack,
  EchoWord,
  ElasticWord,
  GlyphRise,
  NumberRace,
  ScrambleWord,
  SliceWord,
  Slam,
  TypedLine,
} from "../kinetic-type";
import { CollageGrid, GrowToScene, LayoutMorph } from "../layout-morph";
import { audioPulse, progress, track } from "../timing";
import { ScreenPlayback } from "../ui";
import { chalk, coal, ice, indigo, iris, night, pink } from "./kinetic-palette";

const Centre: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", ...style }}>{children}</AbsoluteFill>
);

const display = (fontSize: number, weight = 900): React.CSSProperties => ({
  fontFamily: cyrillicWideFont,
  fontWeight: weight,
  fontSize,
  lineHeight: 1,
});

const small = (fontSize: number): React.CSSProperties => ({
  fontFamily: cyrillicGroteskFont,
  fontWeight: 600,
  fontSize,
  lineHeight: 1.2,
});

/** Speed drawn: a word leaves left, then another up. Look at frames 34 to 39 and 74 to 79. */
export const SmearDemo: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LivingLight
        ground={frame < 40 ? indigo : chalk}
        lights={frame < 40 ? [iris, night] : ["#D9D4FF", "#FFFFFF"]}
        flash={hitsDecay(frame, [40], 3) * 0.6}
        vignette={0.45}
        vignetteColor={frame < 40 ? coal : "#8F8AB8"}
      />
      <Centre>
        <Slam
          motion={{ at: 0, enter: "cut", exitAt: 34, exit: "left", exitFrames: 6, travel: 2600 }}
          color={chalk}
          element="smear-word"
          style={display(235)}
        >
          СКОРОСТЬ
        </Slam>
      </Centre>
      <Centre>
        <Slam
          motion={{ at: 40, fromScale: 1.14, k: 0.7, exitAt: 74, exit: "up", exitFrames: 6, travel: 1600 }}
          color={coal}
          element="smear-word"
          style={display(360)}
        >
          ЩЁЛК
        </Slam>
      </Centre>
    </AbsoluteFill>
  );
};

const SLAM_EVENTS = [8, 44, 80].map((at) => ({ timeSec: at / 30, kind: "kick" as const, strength: 0.9 }));

/** A hit on the whole frame: the word grows from far, the ground flashes, a ring and lines go out, and the camera kicks. */
export const SlamDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const hits = [8, 44, 80];
  const hit = hitsDecay(frame, hits, 7);
  const lines = hitsDecay(frame, hits, 18);
  const latest = [...hits].reverse().find((at) => frame >= at) ?? hits[0]!;
  const kick = hitShake(frame, latest, { seed: "slam", amplitude: 10 });
  const pulse = audioPulse(frame, 30, SLAM_EVENTS, { kinds: ["kick"], frames: 8 });
  return (
    <AbsoluteFill style={{ transform: `translate(${kick.x}px, ${kick.y}px) rotate(${kick.roll}deg)` }}>
      <LivingLight
        ground={night}
        lights={[indigo, iris]}
        energy={0.2 + hit * 0.8}
        flash={hit * 0.55}
        flashColor={pink}
        vignette={0.7}
        vignetteColor={coal}
        seed="slam"
      />
      <RadialField energy={0.04 + lines} color={chalk} accent={pink} seed="slam" clear={0.06} />
      <ShockRing hits={hits} color={pink} />
      <Centre>
        <Slam
          motion={{ at: 8, tilt: { y: -22, z: -6 }, exitAt: 40, exit: "cut" }}
          pulse={pulse * 0.02}
          color={chalk}
          element="slam-word"
          style={display(275)}
        >
          КАЖДЫЙ
        </Slam>
      </Centre>
      <Centre>
        <Slam
          motion={{ at: 44, fromScale: 1.16, k: 0.75, tilt: { z: 2 }, exitAt: 76, exit: "cut" }}
          pulse={pulse * 0.02}
          color={chalk}
          element="slam-word"
          style={display(380)}
        >
          КАДР
        </Slam>
      </Centre>
      <Centre>
        <Slam
          motion={{ at: 80, tilt: { y: 20, z: 5 } }}
          pulse={pulse * 0.02}
          color={chalk}
          element="slam-word"
          style={display(280)}
        >
          ДЕРЖИТ
        </Slam>
      </Centre>
    </AbsoluteFill>
  );
};

/** Letters arrive on their own axes, stretched while fast and squashed on landing, with echoes drifting opposite ways. */
export const GlyphRiseDemo: React.FC = () => (
  <AbsoluteFill>
    <LivingLight ground={pink} lights={["#FF7BAA", "#C5125A"]} vignette={0.5} vignetteColor="#6B0B38" seed="rise" />
    <Centre style={{ top: -270 }}>
      <EchoWord text="ПОДЪЁМ ПОДЪЁМ" drift={-1.4} color={coal} style={display(210)} />
    </Centre>
    <Centre style={{ top: 270 }}>
      <EchoWord text="ПОДЪЁМ ПОДЪЁМ" drift={1.4} color={coal} style={display(210)} />
    </Centre>
    <Centre>
      <GlyphRise text="ПОДЪЁМ" at={6} seed="lift" element="glyph-word" style={{ ...display(290), color: coal }} />
    </Centre>
    <Centre style={{ top: 210 }}>
      <GlyphRise
        text="уровень ноль"
        at={36}
        step={1.6}
        frames={6}
        seed="rest"
        restTilt={4}
        tumble={30}
        rise={0.9}
        style={{ ...small(70), color: chalk, letterSpacing: "0.07em" }}
      />
    </Centre>
  </AbsoluteFill>
);

const DOLLY_WORDS = [
  { text: "СКВОЗЬ", at: 0, tilt: -5, color: chalk },
  { text: "КАЖДОЕ", at: 38, tilt: 4, color: pink },
  { text: "СЛОВО", at: 76, tilt: -3, color: chalk },
  { text: "ДАЛЬШЕ", at: 114, tilt: 5, color: ice },
];

/** The camera goes through a stack of words. The next word is always already there, small, inside the one in front. */
export const DollyDemo: React.FC = () => (
  <AbsoluteFill>
    <LivingLight ground={night} lights={[indigo, "#120B55"]} vignette={0.7} vignetteColor={coal} seed="dolly" />
    <RadialField energy={0.1} color={chalk} seed="dolly" count={110} />
    <DollyStack words={DOLLY_WORDS} rectColor={iris} style={display(170)} />
  </AbsoluteFill>
);

const ELASTIC_KEYS = [
  { at: 0, wdth: 25, wght: 900 },
  { at: 14, wdth: 128, wght: 900 },
  { at: 54, wght: 120 },
  { at: 84, wdth: 60, wght: 1000 },
];

/** Real width and weight axes on cues. The readout under the word is the true value on this frame. */
export const ElasticDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { wdth, wght } = elasticAxes(frame, ELASTIC_KEYS);
  return (
    <AbsoluteFill>
      <LivingLight
        ground={chalk}
        lights={["#FFFFFF", "#CFC9FF"]}
        vignette={0.5}
        vignetteColor="#7F79B0"
        seed="elastic"
      />
      <Centre>
        <ElasticWord
          text="РЕЗИНА"
          keys={ELASTIC_KEYS}
          fontFamily={flexFont}
          element="elastic-word"
          style={{ fontSize: 330, lineHeight: 1, color: coal }}
        />
      </Centre>
      <Centre style={{ top: 290 }}>
        <div
          style={{ ...small(30), color: indigo, fontVariantNumeric: "tabular-nums", whiteSpace: "pre" }}
        >{`ширина ${Math.round(wdth)}   вес ${Math.round(wght)}`}</div>
      </Centre>
    </AbsoluteFill>
  );
};

/** The corruption spreads from the first letter, holds, and all of it resolves at once. */
export const ScrambleDemo: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LivingLight ground={coal} lights={["#17123F", indigo]} vignette={0.6} energy={0.25} seed="scramble" />
      <Centre>
        <div style={{ transform: `scale(${1 + frame * 0.0006})` }}>
          <ScrambleWord
            text="ПАРОЛЬ."
            at={14}
            duration={18}
            seed="word"
            chromaColours={[ice, iris]}
            element="scramble-word"
            style={{ ...display(240), color: pink }}
          />
        </div>
      </Centre>
      <Centre style={{ top: 210 }}>
        <ScrambleWord
          text="// запрос: проверить доступ"
          at={20}
          duration={16}
          seed="line"
          chroma={0}
          style={{ ...small(30), color: chalk, opacity: 0.7, fontFamily: "monospace" }}
        />
      </Centre>
    </AbsoluteFill>
  );
};

const CAPTION = [
  { text: "Каждое", at: 6 },
  { text: "слово", at: 24 },
  { text: "стоит", at: 42 },
  { text: "на", at: 58 },
  { text: "своём", at: 70 },
  { text: "месте.", at: 88 },
];

/** A persistent sentence: the tag travels word to word, over a change of ground. Enlarged at the top to read the move. */
export const CaptionDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const light = frame >= 58;
  return (
    <AbsoluteFill>
      <LivingLight
        ground={light ? chalk : night}
        lights={light ? ["#FFFFFF", "#D5CFFF"] : [indigo, "#1A1250"]}
        flash={hitDecay(frame, 58, 3) * 0.6}
        vignette={0.5}
        vignetteColor={light ? "#7F79B0" : coal}
        seed="caption"
      />
      <AbsoluteFill style={{ padding: 64 }}>
        <BuildingCaption
          words={CAPTION}
          color={light ? coal : chalk}
          tagColor={pink}
          tagTextColor={coal}
          style={small(64)}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ padding: 64, justifyContent: "flex-end" }}>
        <BuildingCaption
          words={CAPTION}
          color={light ? coal : chalk}
          tagColor={pink}
          tagTextColor={coal}
          style={small(26)}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** A line typed in bursts inside a selection box, with a highlight sweeping one word on its cue. */
export const TypingDemo: React.FC = () => (
  <AbsoluteFill>
    <LivingLight ground={chalk} lights={["#FFFFFF", "#D5CFFF"]} vignette={0.25} vignetteColor="#7F79B0" seed="typing" />
    <Centre>
      <TypedLine
        text="Черновик для съёмки"
        at={6}
        seed="brief"
        pace={1.8}
        highlights={[{ text: "съёмки", at: 64, slant: true }]}
        highlightColor="rgba(255,47,126,0.32)"
        box
        boxColor={indigo}
        boxFill="#FFFFFF"
        caretColor={pink}
        style={{ ...small(104), color: coal }}
      />
    </Centre>
  </AbsoluteFill>
);

const MORPH_KEYS = [
  { at: 6, x: 660, y: 780, width: 600, height: 6, radius: 3 },
  { at: 26, x: 360, y: 240, width: 1200, height: 600, radius: 26 },
  { at: 66, x: 1240, y: 90, width: 560, height: 900, radius: 26 },
  { at: 102, x: 0, y: 0, width: 1920, height: 1080, radius: 0 },
];

/** One container: a line becomes a panel, the panel a column, the column the whole next ground. It never cuts. */
export const MorphDemo: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LivingLight ground={night} lights={[indigo, "#1A1250"]} vignette={0.6} vignetteColor={coal} seed="morph" />
      <LayoutMorph keys={MORPH_KEYS} fill={pink}>
        {(rect) => (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              ...display(Math.min(rect.width * 0.125, 150)),
              color: coal,
              whiteSpace: "pre",
            }}
          >
            {frame < 26 ? "" : frame < 66 ? "ПАНЕЛЬ" : frame < 102 ? "СТОЛБЕЦ" : "ГРУНТ"}
          </div>
        )}
      </LayoutMorph>
    </AbsoluteFill>
  );
};

const FAKE_ROWS = ["Длина  15 с", "Формат  16:9", "Темп  120"];
const BUTTON = { x: 420, y: 560, width: 1080, height: 210, radius: 40 };

/** A button swells, drops its label, flattens and eats the interface: its colour is exactly the next scene's ground. */
export const GrowDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const stage = { width: 1920, height: 1080 };
  const interfaceBehind = (
    <AbsoluteFill style={{ alignItems: "center", paddingTop: 170, gap: 40 }}>
      {FAKE_ROWS.map((row, i) => (
        <div key={row} style={{ ...small(62), color: chalk, whiteSpace: "pre", opacity: progress(frame, i * 4, 12) }}>
          {row}
        </div>
      ))}
    </AbsoluteFill>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: frame >= 66 ? pink : coal }}>
      {frame < 66 ? (
        <GrowToScene
          from={BUTTON}
          stage={stage}
          surface={`linear-gradient(120deg, ${iris}, ${pink})`}
          ground={pink}
          at={40}
          frames={26}
          behind={interfaceBehind}
        >
          <span style={{ ...small(84), color: chalk }}>Собрать ролик</span>
        </GrowToScene>
      ) : (
        <Centre>
          <Slam motion={{ at: 66, fromScale: 0.4 }} color={coal} element="grow-next" style={display(230)}>
            ГОТОВО
          </Slam>
        </Centre>
      )}
    </AbsoluteFill>
  );
};

const GRID_STEPS = [
  { at: 8, cell: "root", dir: "x" as const, ratio: 0.42, into: ["left", "right"] as const },
  { at: 26, cell: "right", dir: "y" as const, ratio: 0.3, into: ["top", "bottom"] as const },
  { at: 44, cell: "left", dir: "y" as const, ratio: 0.62, into: ["photo", "count"] as const },
  { at: 62, cell: "bottom", dir: "x" as const, ratio: 0.55, into: ["a", "b"] as const },
  { at: 84, cell: "root", ratio: 0.62 },
  { at: 112, cell: "root", ratio: 1 },
  { at: 112, cell: "left", ratio: 1 },
];

const CELL_COLOURS: Record<string, string> = {
  root: indigo,
  left: indigo,
  right: chalk,
  top: pink,
  bottom: iris,
  photo: indigo,
  count: coal,
  a: "#FFD7E6",
  b: night,
};

const CellBody: React.FC<{ cell: GridCell }> = ({ cell }) => {
  const frame = useCurrentFrame();
  if (cell.id === "count")
    return (
      <AbsoluteFill style={{ backgroundColor: coal, alignItems: "center", justifyContent: "center", color: chalk }}>
        <NumberRace
          size={88}
          at={46}
          frames={50}
          to={3000}
          style={{ fontFamily: cyrillicGroteskFont, fontWeight: 700 }}
        />
      </AbsoluteFill>
    );
  if (cell.id === "top")
    return (
      <AbsoluteFill
        style={{
          backgroundColor: pink,
          alignItems: "center",
          justifyContent: "center",
          ...display(70),
          color: coal,
          whiteSpace: "pre",
        }}
      >
        ДЕЛИТСЯ
      </AbsoluteFill>
    );
  if (cell.id === "photo" || cell.id === "b")
    return (
      <ScreenPlayback kind="image" src="motion-lab/studio.png" position={cell.id === "b" ? "70% 60%" : "30% 20%"} />
    );
  return (
    <AbsoluteFill style={{ backgroundColor: CELL_COLOURS[cell.id] ?? indigo }}>
      <div
        style={{
          position: "absolute",
          left: `${50 + 35 * Math.sin(frame * 0.03 + cell.id.length)}%`,
          top: `${50 + 30 * Math.cos(frame * 0.024 + cell.id.length * 2)}%`,
          width: 900,
          height: 900,
          marginLeft: -450,
          marginTop: -450,
          background: `radial-gradient(circle, ${ice}AA 0%, transparent 62%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/** A grid divides on cues, gutters slide as a cell eats its neighbours, and one cell takes the frame. */
export const CollageDemo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: coal }}>
    <CollageGrid
      steps={GRID_STEPS}
      stage={{ width: 1920, height: 1080 }}
      gutter={14}
      ground={coal}
      cell={(cell) => <CellBody cell={cell} />}
    />
  </AbsoluteFill>
);

/** An odometer: the fast columns are smudges, and the columns stop one by one from the left. */
export const RaceDemo: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <LivingLight
        ground={night}
        lights={[indigo, "#1A1250"]}
        vignette={0.7}
        vignetteColor={coal}
        seed="race"
        energy={0.2}
      />
      <Centre style={{ flexDirection: "column", gap: 20, color: pink, transform: `scale(${1 + frame * 0.0004})` }}>
        <NumberRace
          size={250}
          at={6}
          frames={84}
          to={3108}
          style={{ fontFamily: cyrillicWideFont, fontWeight: 800 }}
          element="race-number"
        />
        <div style={{ ...display(60, 800), color: chalk, whiteSpace: "pre" }}>КАДРОВ В РОЛИКЕ</div>
      </Centre>
    </AbsoluteFill>
  );
};

/** The line field and the ring alone: calm and sparse, a build, a hit, then decay. */
export const RadialDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const build = track(frame, [
    { at: 0, value: 0 },
    { at: 48, value: 0.25, curve: "expoIn" },
  ]);
  const hit = hitDecay(frame, 48, 34);
  return (
    <AbsoluteFill>
      <LivingLight
        ground={night}
        lights={[indigo]}
        energy={0.2 + hit}
        flash={hitDecay(frame, 48, 6) * 0.5}
        flashColor={iris}
        vignette={0.7}
        vignetteColor={coal}
        seed="radial"
      />
      <RadialField energy={Math.max(build, hit)} color={chalk} accent={ice} seed="field" />
      <ShockRing hits={[48]} color={ice} />
      <Centre>
        <div
          style={{
            width: 8 + build * 40,
            height: 8 + build * 40,
            borderRadius: "50%",
            backgroundColor: frame < 48 ? ice : "transparent",
            boxShadow: frame < 48 ? `0 0 ${20 + build * 80}px ${ice}` : undefined,
          }}
        />
      </Centre>
    </AbsoluteFill>
  );
};

/** A ground that breathes: three soft lights, dark corners, grain, and a flash on two cues. */
export const LightDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const flash = hitsDecay(frame, [40, 90], 7);
  return (
    <AbsoluteFill>
      <LivingLight
        ground="#180F66"
        lights={[pink, iris, ice]}
        energy={0.35 + flash * 0.6}
        flash={flash * 0.4}
        vignette={0.75}
        vignetteColor={coal}
        speed={0.012}
        seed="demo"
      />
      <FilmGrain seed="demo" opacity={0.16} />
    </AbsoluteFill>
  );
};

/** A comet draws a line through a word; on the hit the word is cut along it and the line stays. */
export const LightPathDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const hit = hitDecay(frame, 40, 7);
  return (
    <AbsoluteFill>
      <LivingLight
        ground={night}
        lights={[indigo, "#1A1250"]}
        flash={hit * 0.5}
        flashColor={pink}
        vignette={0.7}
        vignetteColor={coal}
        seed="path"
      />
      <Centre>
        <SliceWord
          at={40}
          style={{ ...display(240), color: chalk, transform: `scale(${1 + settle(frame, 0.01) * 0.1})` }}
        >
          РАЗРЕЗ
        </SliceWord>
      </Centre>
      <LightPath d="M 120 880 C 600 780 1300 330 1830 200" at={22} frames={18} color={pink} />
      <LightPath
        d="M 80 120 C 300 180 420 540 760 500 S 1500 880 1860 760"
        at={72}
        frames={30}
        color={ice}
        strokeWidth={2}
      />
    </AbsoluteFill>
  );
};
