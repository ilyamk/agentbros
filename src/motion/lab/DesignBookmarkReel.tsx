import { Audio } from "@remotion/media";
import React from "react";
import { AbsoluteFill, Freeze, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { GlassLens, glassLensCues, glassLensDefaults } from "../library/camera/GlassLens";
import { StyledCaptions } from "../library/captions/Captions";
import { elasticWordBoxPreset } from "../library/captions/style";
import { FilmFinish } from "../library/finish/FilmFinish";
import { EditorialPage, PageTurn, pageTurnCues, pageTurnDefaults } from "../library/transitions/PageTurn";
import { StateMorph, stateMorphCues, stateMorphDefaults } from "../library/ui/StateMorph";
import { SwipeDeck, swipeDeckCues, swipeDeckDefaults } from "../library/ui/SwipeDeck";
import { progress } from "../timing";

const PAPER = "#E9EDDE";
const INK = "#192620";
const GREEN = "#CFED84";
const WHITE = "#F1F1E3";

const IMPORT = 52;
const DECK = 160;
const LENS = 267;
const PAGE = 349;
export const DESIGNBOOKMARK_REEL_FRAMES = 451;

const state = {
  ...stateMorphDefaults,
  title: "Import sheets",
  pending: "Processing",
  result: "Sheets ready",
  detail: "Light, form and texture",
  at: 22,
  readyAt: 53,
  ground: PAPER,
};

const deck = {
  ...swipeDeckDefaults,
  ground: INK,
  at: 24,
  step: 31,
  moveFrames: 19,
  cards: [
    { title: "Light", label: "ATLAS / 01", paper: "#E1E9B6", ink: "#283928" },
    { title: "Form", label: "ATLAS / 02", paper: "#CCD9EC", ink: "#243C54" },
    { title: "Texture", label: "ATLAS / 03", paper: "#E9D7B8", ink: "#523920" },
  ],
};

const lens = {
  ...glassLensDefaults,
  ground: INK,
  radius: 0.151,
  zoom: 1.53,
  stops: [
    { at: 0, x: 0.49, y: 0.492 },
    { at: 7, x: 0.49, y: 0.492 },
    { at: 35, x: 0.672, y: 0.465 },
    { at: 76, x: 0.672, y: 0.465 },
  ],
};

const turn = { ...pageTurnDefaults, seamFrame: 38, moveFrames: 28, paper: "#F0E5C9" };

const Header: React.FC<{ title: string; colour: string }> = ({ title, colour }) => {
  const { width } = useVideoConfig();
  return (
    <div
      style={{
        position: "absolute",
        top: "16%",
        left: "10%",
        right: "10%",
        borderTop: `2px solid ${colour}`,
        paddingTop: width * 0.035,
        color: colour,
        font: `${width * 0.072}px/0.98 Georgia, serif`,
        letterSpacing: "-0.045em",
      }}
    >
      {title}
    </div>
  );
};

const Opening: React.FC = () => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const move = progress(frame, 34, 18, "drift");
  return (
    <AbsoluteFill style={{ background: PAPER, color: INK }}>
      <svg
        viewBox="0 0 640 470"
        style={{
          position: "absolute",
          width: "83%",
          height: "auto",
          left: "8%",
          top: "23%",
          transform: `translateY(${move * width * 0.092}px) scale(${1 - move * 0.19})`,
        }}
      >
        <rect x="39" y="48" width="562" height="366" rx="16" fill={GREEN} />
        {Array.from({ length: 17 }, (_, i) => (
          <ellipse
            key={i}
            cx={318 + i * 2}
            cy={230 - i * 1.6}
            rx={247 - i * 10}
            ry={140 - i * 5.6}
            transform="rotate(-19 320 235)"
            stroke={INK}
            strokeWidth={i % 5 === 0 ? 2.1 : 1}
            fill="none"
          />
        ))}
      </svg>
      <div
        style={{
          position: "absolute",
          left: "10%",
          right: "10%",
          top: "57%",
          borderTop: `2px solid ${INK}`,
          paddingTop: width * 0.045,
          font: `${width * 0.122}px/0.91 Georgia, serif`,
          letterSpacing: "-0.055em",
        }}
      >
        From file
        <br />
        to frame
      </div>
    </AbsoluteFill>
  );
};

const ImportShot: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const travel = progress(frame, 4, state.at - 4, "drift");
  const hide = progress(frame, state.at - 3, 3, "linear");
  return (
    <AbsoluteFill>
      <StateMorph {...state} />
      <Header title="Import" colour={INK} />
      {frame < state.at ? (
        <div
          style={{
            position: "absolute",
            top: height * (0.37 + 0.13 * travel),
            left: width * (0.5 - 0.075 * (1 - travel)),
            transform: `translate(-50%, -50%) rotate(${(1 - travel) * -8}deg) scale(${1 - 0.23 * travel})`,
            display: "flex",
            alignItems: "center",
            gap: width * 0.018,
            padding: `${width * 0.015}px ${width * 0.022}px`,
            background: GREEN,
            color: INK,
            border: `2px solid ${INK}`,
            borderRadius: width * 0.014,
            font: `600 ${width * 0.031}px Arial, sans-serif`,
            whiteSpace: "nowrap",
            opacity: 1 - hide,
          }}
        >
          <svg width={width * 0.044} height={width * 0.044} viewBox="0 0 44 44" aria-hidden>
            <path
              d="M10 9h18l7 7v19H10zM28 9v8h7m-19 5h13m-13 6h13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          3 sheets
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const DeckShot: React.FC = () => (
  <AbsoluteFill>
    <SwipeDeck {...deck} />
    <Header title="Choose a sheet" colour={WHITE} />
    <StyledCaptions
      {...elasticWordBoxPreset}
      active={{ ...elasticWordBoxPreset.active, boxText: INK, scale: 1 }}
      accent={GREEN}
      textColor={WHITE}
      entry="none"
      language="en"
      maxWords={4}
      words={[
        { text: "Light", start: 0.2, end: 1.15 },
        { text: "form", start: 1.15, end: 2.2 },
        { text: "texture", start: 2.2, end: (LENS - DECK) / 30 },
      ]}
    />
  </AbsoluteFill>
);

const LensShot: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      <GlassLens {...lens} radius={0.05 + (lens.radius - 0.05) * progress(frame, 0, 12, "expoOut")}>
        <Freeze frame={LENS - DECK - 1}>
          <SwipeDeck {...deck} />
        </Freeze>
      </GlassLens>
      <Header title="Detail" colour={WHITE} />
    </AbsoluteFill>
  );
};

const PaperShot: React.FC = () => (
  <PageTurn
    {...turn}
    from={<EditorialPage title="Texture" label="ATLAS / 03" paper="#E9D7B8" ink="#523920" />}
    to={<EditorialPage title="Atlas of Light" label="LIGHT / FORM / TEXTURE" paper={PAPER} ink={INK} reverse />}
  />
);

const soundFrames = [
  { frame: IMPORT + stateMorphCues(state)[0]!.frame, file: "click", gain: 0.24 },
  { frame: IMPORT + stateMorphCues(state)[1]!.frame, file: "chime", gain: 0.26 },
  ...swipeDeckCues(deck).map((cue) => ({ frame: DECK + cue.frame, file: "tick", gain: 0.17 })),
  { frame: LENS + glassLensCues(lens)[0]!.frame, file: "glass", gain: 0.17 },
  { frame: PAGE + pageTurnCues(turn)[0]!.frame - 7, file: "whoosh", gain: 0.17 },
];

export const DesignBookmarkReel: React.FC<{ sound: boolean }> = ({ sound }) => (
  <AbsoluteFill>
    <FilmFinish grain={0.024} seed="light-atlas">
      <Sequence durationInFrames={IMPORT} name="From file to frame">
        <Opening />
      </Sequence>
      <Sequence from={IMPORT} durationInFrames={DECK - IMPORT} name="Import to result">
        <ImportShot />
      </Sequence>
      <Sequence from={DECK} durationInFrames={LENS - DECK} name="Select a sheet">
        <DeckShot />
      </Sequence>
      <Sequence from={LENS} durationInFrames={PAGE - LENS} name="See the detail">
        <LensShot />
      </Sequence>
      <Sequence from={PAGE} durationInFrames={DESIGNBOOKMARK_REEL_FRAMES - PAGE} name="Turn the page">
        <PaperShot />
      </Sequence>
    </FilmFinish>
    {sound
      ? soundFrames.map(({ frame, file, gain }) => (
          <Sequence key={frame} from={frame} layout="none">
            <Audio src={staticFile(`projects/designbookmark-motion/assets/sfx/synth/${file}.wav`)} volume={gain} />
          </Sequence>
        ))
      : null}
  </AbsoluteFill>
);
