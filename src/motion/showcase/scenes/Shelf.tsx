import React from "react";
import { AbsoluteFill, random, useCurrentFrame } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../../lib/fonts-cyrillic";
import { Camera, DepthLayer } from "../../camera";
import { projectLayer, type CameraPose, type Lens } from "../../camera-math";
import { FilmGrain } from "../../fx";
import { FittedLine, MaskedLine } from "../../text";
import { progress, track, velocity } from "../../timing";
import { ember, kraft, kraftDark, label as labelPaper, roast, shelfWall } from "../palette";
import { Label, useLabelFonts, type LabelFonts } from "./Label";

const STRIP = [
  "12 АПРЕЛЯ",
  "12 МАЯ",
  "12 ИЮНЯ",
  "12 ИЮЛЯ",
  "12 АВГУСТА",
  "12 СЕНТЯБРЯ",
  "12 ОКТЯБРЯ",
  "12 НОЯБРЯ",
  "214 ДНЕЙ НАЗАД",
];

const PACK = { width: 460, height: 700, labelScale: 400 / 1920, pitch: 520 };
/** World position of the hero pack: its label is centred on the frame, so at full dolly it fills it. */
const HERO_LEFT = 960 - PACK.width / 2;
const SHELF_TOP = 540 - 225 / 2 - 196;
const PLANK_Y = SHELF_TOP + PACK.height;

const LENS: Lens = { focal: 1400, aperture: 0.02, rackScale: 0 };
/** 1400 / (1400 - dolly) = 4.8: the 400-wide sticker exactly fills 1920. */
const FULL_DOLLY = 1400 - 1400 / 4.8;

const DRUM = (f: number): number =>
  track(f, [
    { at: 16, value: 0 },
    { at: 22, value: -0.08, curve: "drift" },
    { at: 50, value: STRIP.length - 1 + 0.05, curve: "inOut" },
    { at: 58, value: STRIP.length - 1, curve: "expoOut" },
  ]);

const PULL_START = 96;
const PULL_END = 144;
const DOLLY = (f: number): number =>
  track(f, [
    { at: 0, value: FULL_DOLLY },
    { at: PULL_START, value: FULL_DOLLY },
    { at: PULL_END, value: 0, curve: "drift" },
  ]);
const hitPulse = (f: number): number => 22 * (f < 50 ? 0 : 1 - progress(f, 50, 12, "expoOut"));

const PAN = (f: number): number =>
  track(f, [
    { at: 120, value: 0 },
    { at: 342, value: 3480, curve: (t) => t ** 1.7 },
  ]);
const FOCUS = (f: number): number =>
  track(f, [
    { at: 186, value: 0 },
    { at: 200, value: 620, curve: "drift" },
  ]);

/** Older as you walk along the shelf. */
const AGES = [175, 190, 214, 268, 339, 406, 455, 498, 517, 548, 576];
const DISCOUNTED_FROM = 339;
const HERO_INDEX = 2;

type PackProps = { index: number; fonts: LabelFonts; children?: React.ReactNode; dim?: number; plain?: boolean };

const Pack: React.FC<PackProps> = ({ index, fonts, children, dim = 0, plain }) => {
  const tone = random(`pack-${index}`);
  const left = HERO_LEFT + (index - HERO_INDEX) * PACK.pitch;
  const age = AGES[((index % AGES.length) + AGES.length) % AGES.length]!;
  return (
    <div
      data-element="shelf-pack"
      style={{
        position: "absolute",
        left,
        top: SHELF_TOP,
        width: PACK.width,
        height: PACK.height,
        borderRadius: "6px 6px 3px 3px",
        background: `linear-gradient(90deg, ${kraftDark} 0%, ${kraft} 12%, ${kraft} 82%, ${kraftDark} 100%)`,
        filter: `brightness(${0.9 + tone * 0.14 - dim})`,
        boxShadow: "0 18px 26px rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 60,
          background: `linear-gradient(180deg, ${kraftDark}, ${kraft})`,
          borderBottom: "2px solid rgba(0,0,0,0.25)",
          borderRadius: "6px 6px 0 0",
        }}
      />
      {plain ? null : (
        <div
          style={{
            position: "absolute",
            left: 30,
            top: 92,
            fontFamily: cyrillicCondensedFont,
            fontWeight: 800,
            fontSize: 80,
            lineHeight: 1,
            color: roast,
            whiteSpace: "pre",
          }}
        >
          АРАБИКА 100%
        </div>
      )}
      {plain ? null : (
        <div
          style={{
            position: "absolute",
            left: 30,
            top: 196,
            width: 400,
            height: 225,
            overflow: "hidden",
            boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ width: 1920, height: 1080, transformOrigin: "0 0", transform: `scale(${PACK.labelScale})` }}>
            {children ?? (
              <Label fonts={fonts} strip={[`${age} ДНЕЙ НАЗАД`]} position={0} footerLeft="Кофе в зёрнах, 250 г" />
            )}
          </div>
        </div>
      )}
      {plain || age < DISCOUNTED_FROM ? null : (
        <div
          style={{
            position: "absolute",
            right: -14,
            top: 372,
            width: 128,
            height: 128,
            borderRadius: "50%",
            backgroundColor: ember,
            color: labelPaper,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: cyrillicCondensedFont,
            fontWeight: 800,
            fontSize: 58,
            transform: "rotate(-10deg)",
            whiteSpace: "pre",
          }}
        >
          −30%
        </div>
      )}
      {plain ? null : (
        <div
          style={{
            position: "absolute",
            left: 30,
            bottom: 44,
            fontFamily: cyrillicGroteskFont,
            fontWeight: 600,
            fontSize: 32,
            color: roast,
            opacity: 0.8,
            whiteSpace: "pre",
          }}
        >
          Хранить в сухом месте
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{
  from: number;
  to: number;
  fonts: LabelFonts;
  top?: number;
  shift?: number;
  dim?: number;
  hero?: React.ReactNode;
  plain?: boolean;
}> = ({ from, to, fonts, top = 0, shift = 0, dim, hero, plain }) => (
  <div style={{ position: "absolute", left: shift, top, width: 0, height: 0 }}>
    {Array.from({ length: to - from + 1 }, (_, i) => from + i).map((index) => (
      <Pack key={index} index={index} fonts={fonts} dim={dim} plain={plain}>
        {index === HERO_INDEX ? hero : undefined}
      </Pack>
    ))}
  </div>
);

const Plank: React.FC<{ y: number }> = ({ y }) => (
  <div
    style={{
      position: "absolute",
      left: -3000,
      width: 9000,
      top: y,
      height: 64,
      background: "linear-gradient(180deg, #5B4A38 0%, #3A2F24 30%, #16110C 100%)",
      boxShadow: "0 30px 40px rgba(0,0,0,0.55)",
    }}
  />
);

const visibleRange = (x: number, scale: number): [number, number] => {
  const span = 960 / scale + PACK.pitch * 1.5;
  const centre = (960 + x - HERO_LEFT - PACK.width / 2) / PACK.pitch + HERO_INDEX;
  return [Math.floor(centre - span / PACK.pitch), Math.ceil(centre + span / PACK.pitch)];
};

/**
 * Starts as a full-frame label, so frame 0 is a finished poster. The date drum spins through the months; the camera
 * then pulls back and the poster turns out to be a sticker on one pack among many.
 */
export const Shelf: React.FC = () => {
  const frame = useCurrentFrame();
  const fonts = useLabelFonts();
  if (fonts === null) return <AbsoluteFill style={{ backgroundColor: labelPaper }} />;

  const pose: CameraPose = { x: PAN(frame), y: 0, dolly: DOLLY(frame) + hitPulse(frame), roll: 0, focus: FOCUS(frame) };
  const heroScale = projectLayer(pose, 0, LENS).scale;
  const backScale = projectLayer(pose, 150, LENS).scale;
  const [from, to] = visibleRange(pose.x, heroScale);
  const [backFrom, backTo] = visibleRange(pose.x * (backScale / heroScale), backScale);
  const pulled = frame >= PULL_START - 2;
  const asideGone = 1 - progress(frame, 12, 10, "expoOut");
  const textOne = frame >= 198 && frame < 264;
  const textTwo = frame >= 264;
  const dim = track(frame, [
    { at: 186, value: 0 },
    { at: 202, value: 0.52, curve: "drift" },
  ]);

  const hero = (
    <Label
      fonts={fonts}
      strip={STRIP}
      position={DRUM(frame)}
      speed={velocity(DRUM, frame)}
      footerLeft="Кофе в зёрнах, 250 г"
      aside={
        asideGone > 0 ? (
          <div
            style={{
              position: "absolute",
              right: LABEL_RIGHT,
              top: 640,
              textAlign: "right",
              fontFamily: cyrillicGroteskFont,
              fontWeight: 700,
              fontSize: 88,
              lineHeight: 1.04,
              letterSpacing: "-0.03em",
              color: roast,
              whiteSpace: "pre",
              opacity: asideGone,
            }}
          >
            {"сегодня\n12 ноября"}
          </div>
        ) : null
      }
    />
  );

  return (
    <AbsoluteFill style={{ backgroundColor: shelfWall }}>
      <Camera pose={pose} lens={LENS}>
        {pulled ? (
          <DepthLayer depth={150}>
            <AbsoluteFill style={{ backgroundColor: "transparent" }}>
              <Row from={backFrom} to={backTo} fonts={fonts} shift={PACK.pitch / 2} dim={0.42} plain />
            </AbsoluteFill>
          </DepthLayer>
        ) : null}
        <DepthLayer depth={0}>
          {pulled ? (
            <>
              <Row from={from} to={to} fonts={fonts} top={-PACK.height - 150} />
              <Plank y={SHELF_TOP - 64} />
              <Row from={from} to={to} fonts={fonts} top={PACK.height + 104} />
              <Plank y={PLANK_Y} />
            </>
          ) : null}
          <Row from={pulled ? from : HERO_INDEX} to={pulled ? to : HERO_INDEX} fonts={fonts} hero={hero} />
        </DepthLayer>
      </Camera>
      <AbsoluteFill style={{ backgroundColor: "#000", opacity: dim }} />
      {textOne ? <ShelfLine lines={["ЖАРЯТ НА СКЛАД"]} from={198} /> : null}
      {textTwo ? <ShelfLine lines={["НЕ ЗНАЮТ,", "СКОЛЬКО КУПЯТ"]} from={264} /> : null}
      <FilmGrain seed="shelf" opacity={0.1} />
    </AbsoluteFill>
  );
};

const LABEL_RIGHT = 72;

const ShelfLine: React.FC<{ lines: readonly string[]; from: number }> = ({ lines, from }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 72,
        right: 72,
        bottom: 80,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {lines.map((line, i) => (
        <FittedLine
          key={line}
          text={line}
          withinWidth={1776}
          fontFamily={cyrillicCondensedFont}
          fontWeight={800}
          maxFontSize={lines.length > 1 ? 400 : 520}
        >
          {(fontSize) => (
            <MaskedLine
              reveal={progress(frame, from + i * 4, 16)}
              lineHeight={0.86}
              style={{ fontFamily: cyrillicCondensedFont, fontWeight: 800, fontSize, color: labelPaper }}
            >
              {line}
            </MaskedLine>
          )}
        </FittedLine>
      ))}
    </div>
  );
};
