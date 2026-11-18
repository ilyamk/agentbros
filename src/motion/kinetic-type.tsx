import React, { useId } from "react";
import { useCurrentFrame } from "remotion";
import {
  captionWords,
  dollyPosition,
  dollyWord,
  elasticAxes,
  glyphRiseAt,
  odometerReels,
  raceValue,
  scrambleChroma,
  scrambleGlyphs,
  smearAt,
  typedCount,
  typingSchedule,
  wordPose,
  wordSpeed,
  type AxisKeyframe,
  type CaptionWord,
  type DollyOptions,
  type DollyWordOptions,
  type GlyphRiseOptions,
  type RaceOptions,
  type ScrambleOptions,
  type SmearOptions,
  type TypingOptions,
  type WordMotion,
} from "./kinetic-math";
import { splitGraphemes } from "./text-split";
import { progress } from "./timing";

const fringe = (chroma: number, colours: readonly [string, string]): string =>
  chroma < 0.4 ? "" : `drop-shadow(${chroma}px 0 0 ${colours[0]}) drop-shadow(${-chroma}px 0 0 ${colours[1]})`;

const CHROMA_DEFAULT: readonly [string, string] = ["rgba(255,40,90,0.85)", "rgba(40,220,255,0.85)"];

type SmearProps = {
  /** Pixels per frame, normally from `wordSpeed` or `velocity`. */
  vx?: number;
  vy?: number;
  options?: SmearOptions;
  /** Break the streak into rows, as long exposure does to type. Off for small moves and scale changes. */
  rows?: boolean;
  /** Seed of the row pattern; hold it through a move so that the rows do not flicker. */
  seed?: number;
  chromaColours?: readonly [string, string];
  children: React.ReactNode;
  style?: React.CSSProperties;
};

/**
 * Speed drawn as a picture: stretches along the move, shifts each row by its own amount, blurs along the move and
 * splits colour. All of it is a function of speed, so a settled element is untouched.
 */
export const Smear: React.FC<SmearProps> = ({
  vx = 0,
  vy = 0,
  options,
  rows = true,
  seed = 3,
  chromaColours = CHROMA_DEFAULT,
  children,
  style,
}) => {
  const id = useId().replaceAll(":", "");
  const horizontal = Math.abs(vx) >= Math.abs(vy);
  const { blur, stretch, rowShift, rowCut, chroma } = smearAt(horizontal ? vx : vy, options);
  const active = blur > 0.3;
  const chain = active ? `url(#${id}) ${fringe(chroma, chromaColours)}`.trim() : undefined;
  return (
    <div
      style={{
        display: "inline-block",
        filter: chain,
        transform: stretch === 1 ? undefined : horizontal ? `scaleX(${stretch})` : `scaleY(${stretch})`,
        ...style,
      }}
    >
      {active ? (
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <filter id={id} x="-150%" y="-150%" width="400%" height="400%" colorInterpolationFilters="sRGB">
            {rows ? (
              <>
                <feTurbulence
                  type="fractalNoise"
                  baseFrequency={horizontal ? "0 0.05" : "0.05 0"}
                  numOctaves={3}
                  seed={seed}
                  result="noise"
                />
                <feColorMatrix
                  in="noise"
                  type="matrix"
                  values="1.8 0 0 0 -0.4  0 0 0 0 0  0 0 0 0 0.5  0 0 0 0 1"
                  result="rows"
                />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="rows"
                  scale={rowShift}
                  xChannelSelector={horizontal ? "R" : "B"}
                  yChannelSelector={horizontal ? "B" : "R"}
                  result="shifted"
                />
                <feGaussianBlur in="shifted" stdDeviation={horizontal ? `${blur} 0` : `0 ${blur}`} result="streak" />
                <feColorMatrix
                  in="noise"
                  type="matrix"
                  values={`0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.4 0 0 0 ${1 - rowCut * 2.3}`}
                  result="bands"
                />
                <feComposite in="streak" in2="bands" operator="in" />
              </>
            ) : (
              <feGaussianBlur stdDeviation={horizontal ? `${blur} 0` : `0 ${blur}`} />
            )}
          </filter>
        </svg>
      ) : null}
      {children}
    </div>
  );
};

type ZoomSmearProps = {
  /** Share of extra scale the last copy has: 0 is one sharp copy, 1 a long tail of zoom. */
  amount: number;
  copies?: number;
  children: React.ReactNode;
};

/** A radial zoom blur built from scaled copies of the children, since CSS has no radial filter. Layout comes from the first copy. */
export const ZoomSmear: React.FC<ZoomSmearProps> = ({ amount, copies = 7, children }) => {
  if (amount <= 0.01) return <>{children}</>;
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <div style={{ filter: `blur(${amount * 6}px)`, opacity: 0.7 }}>{children}</div>
      {Array.from({ length: copies }, (_, i) => {
        const t = (i + 1) / copies;
        return (
          <div
            key={i}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              transform: `scale(${1 + amount * t})`,
              opacity: (0.5 * (1 - t)) ** 0.8,
              filter: `blur(${amount * 4 * (1 + t * 2)}px)`,
            }}
          >
            {children}
          </div>
        );
      })}
    </div>
  );
};

type SlamProps = {
  motion: WordMotion;
  /** Half the word's width, in pixels: turns the scale change into an edge speed for the blur. */
  halfWidth?: number;
  /** Extra scale added by the sound, from `audioPulse`. */
  pulse?: number;
  smear?: SmearOptions;
  /** Colour on the hit frame, settling to `color` over 6 frames. */
  hitColor?: string;
  color?: string;
  glow?: string;
  /** Identifies the word to motion-check. */
  element?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

/**
 * A word with a whole life: lands, creeps on the hold, leaves with its speed drawn. `motion.enter` "slam" grows from far
 * and "lens" falls from past the camera; `motion.exit` "through" zooms past it. Place it with the parent.
 */
export const Slam: React.FC<SlamProps> = ({
  motion,
  halfWidth = 420,
  pulse = 0,
  smear,
  hitColor,
  color,
  glow,
  element,
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const pose = wordPose(frame, motion);
  if (!pose.visible) return null;
  const { vx, vy, vScale } = wordSpeed(frame, motion, halfWidth);
  const lateral = Math.abs(vx) + Math.abs(vy) > 0.5;
  // The filter sits inside the scale, so speed is converted to the word's own pixels.
  const local = 1 / Math.max(pose.scale, 0.01);
  // A 3D transform promotes the word to a layer that keeps its old raster scale, so a settled word must go back to 2D or a frame depends on the frames before it.
  const flat = Math.abs(pose.rotateX) + Math.abs(pose.rotateY) < 0.05;
  const through = motion.exit === "through" && motion.exitAt !== undefined && frame >= motion.exitAt;
  const zoom = through ? Math.min(Math.abs(vScale) / halfWidth, 1.6) : 0;
  const hit = hitColor ? progress(frame, motion.at, 6, "linear") : 1;
  const textColor = hitColor && hit < 1 ? hitColor : color;
  const word = (
    <div data-element={element} style={{ whiteSpace: "pre", color: textColor, textShadow: glow, ...style }}>
      {children}
    </div>
  );
  return (
    <div
      style={{
        opacity: pose.opacity,
        transform: `${flat ? "" : `perspective(1400px) rotateX(${pose.rotateX}deg) rotateY(${pose.rotateY}deg) `}translate(${pose.x}px, ${pose.y}px) rotateZ(${pose.rotateZ}deg) scale(${pose.scale * (1 + pulse)})`,
      }}
    >
      <Smear
        vx={lateral ? vx * local : through ? 0 : vScale * local}
        vy={lateral ? vy * local : 0}
        rows={lateral}
        seed={Math.abs(motion.at) % 97}
        options={lateral ? smear : { shutter: 0.22, stretchPer100: 0, chromaPer100: 3, ...smear }}
      >
        {through ? <ZoomSmear amount={zoom}>{word}</ZoomSmear> : word}
      </Smear>
    </div>
  );
};

type GlyphRiseProps = GlyphRiseOptions & {
  text: string;
  locale?: string;
  /** Word entering the frame, for motion-check. */
  element?: string;
  style?: React.CSSProperties;
};

/** Letters tumble in one by one on their own axes, stretching along their move and squashing on arrival. */
export const GlyphRise: React.FC<GlyphRiseProps> = ({ text, locale, element, style, ...options }) => {
  const frame = useCurrentFrame();
  return (
    <span data-element={element} aria-label={text} style={{ display: "inline-block", whiteSpace: "pre", ...style }}>
      {splitGraphemes(text, locale).map((grapheme, index) => {
        const glyph = glyphRiseAt(frame, index, options);
        return (
          <span
            key={`${index}-${grapheme}`}
            aria-hidden
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: glyph.opacity,
              filter: glyph.blur > 0.3 ? `blur(${glyph.blur}px)` : undefined,
              transformOrigin: "50% 80%",
              transform: `${Math.abs(glyph.rotateX) + Math.abs(glyph.rotateY) < 0.05 ? "" : `perspective(700px) rotateX(${glyph.rotateX}deg) rotateY(${glyph.rotateY}deg) `}translateY(${glyph.y}em) rotateZ(${glyph.rotateZ}deg) scale(${glyph.scaleAcross}, ${glyph.scaleAlong})`,
            }}
          >
            {grapheme}
          </span>
        );
      })}
    </span>
  );
};

export type DollyStackWord = { text: string; at: number; tilt?: number; color?: string };

type DollyStackProps = DollyOptions &
  DollyWordOptions & {
    words: readonly DollyStackWord[];
    /** A hairline frame that goes with each word through depth. */
    rectColor?: string;
    style?: React.CSSProperties;
  };

/** Words at depths along the lens. The camera goes from one to the next on the cues; the next word is already visible inside the last. Fills its parent. */
export const DollyStack: React.FC<DollyStackProps> = ({ words, travel, creep, ratio, near, far, rectColor, style }) => {
  const frame = useCurrentFrame();
  const position = dollyPosition(
    frame,
    words.map((word) => word.at),
    { travel, creep },
  );
  return (
    <div style={{ position: "absolute", inset: 0, perspective: 1600, overflow: "hidden" }}>
      {words
        .map((word, index) => ({ word, index, state: dollyWord(position, index, { ratio, near, far }) }))
        .reverse()
        .map(({ word, index, state }) =>
          !state.visible ? null : (
            <div
              key={`${index}-${word.text}`}
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: state.opacity,
                filter: state.blur > 0.4 ? `blur(${state.blur}px)` : undefined,
                transform: `scale(${state.scale}) rotateZ(${word.tilt ?? 0}deg) rotateY(${(position - index) * 18}deg)`,
              }}
            >
              <div
                data-element="dolly-word"
                style={{ position: "relative", whiteSpace: "pre", color: word.color, ...style }}
              >
                {rectColor ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: "-0.32em -0.46em",
                      border: `2px solid ${rectColor}`,
                      borderRadius: 8,
                    }}
                  />
                ) : null}
                {word.text}
              </div>
            </div>
          ),
        )}
    </div>
  );
};

type ElasticWordProps = {
  text: string;
  keys: readonly AxisKeyframe[];
  /** A face with both axes. Without a `wdth` axis, the width will not move. */
  fontFamily: string;
  /** Pixels of edge travel per unit of width, for the blur on fast frames. */
  pxPerWdth?: number;
  style?: React.CSSProperties;
  element?: string;
};

/** A word on real variable axes, driven by cues: lands past each target and rings back. */
export const ElasticWord: React.FC<ElasticWordProps> = ({ text, keys, fontFamily, pxPerWdth = 3, style, element }) => {
  const frame = useCurrentFrame();
  const { wdth, wght } = elasticAxes(frame, keys);
  const next = elasticAxes(frame + 1, keys);
  return (
    <Smear
      vx={(next.wdth - wdth) * pxPerWdth}
      rows={false}
      options={{ shutter: 0.2, stretchPer100: 0, chromaPer100: 0 }}
    >
      <div
        data-element={element}
        style={{ whiteSpace: "pre", fontFamily, fontVariationSettings: `"wdth" ${wdth}, "wght" ${wght}`, ...style }}
      >
        {text}
      </div>
    </Smear>
  );
};

type ScrambleWordProps = ScrambleOptions & {
  text: string;
  locale?: string;
  /** Largest colour split, in pixels. */
  chroma?: number;
  chromaColours?: readonly [string, string];
  style?: React.CSSProperties;
  element?: string;
};

/** A word that corrupts from its first letter and resolves all at once, reflowing as glyph widths change. */
export const ScrambleWord: React.FC<ScrambleWordProps> = ({
  text,
  locale,
  chroma = 9,
  chromaColours = CHROMA_DEFAULT,
  style,
  element,
  ...options
}) => {
  const frame = useCurrentFrame();
  const glyphs = scrambleGlyphs(splitGraphemes(text, locale), frame, options);
  const split = scrambleChroma(frame, options.at, options.duration, chroma);
  return (
    <div
      data-element={element}
      style={{ whiteSpace: "pre", filter: fringe(split, chromaColours) || undefined, ...style }}
    >
      {glyphs.join("")}
    </div>
  );
};

type BuildingCaptionProps = {
  words: readonly CaptionWord[];
  tagFrames?: number;
  color: string;
  tagColor: string;
  tagTextColor: string;
  style?: React.CSSProperties;
};

/**
 * A small sentence that grows with the film and survives its cuts. The newest word wears a tag; the tag travels to the
 * next word. Mount it above the scenes and pass colours for the current ground.
 */
export const BuildingCaption: React.FC<BuildingCaptionProps> = ({
  words,
  tagFrames = 4,
  color,
  tagColor,
  tagTextColor,
  style,
}) => {
  const frame = useCurrentFrame();
  const states = captionWords(frame, words, tagFrames);
  return (
    <div data-element="building-caption" style={{ display: "flex", gap: "0.3em", whiteSpace: "pre", color, ...style }}>
      {words.map((word, index) => {
        const state = states[index]!;
        if (!state.visible) return null;
        const covered = state.tagTo > state.tagFrom;
        return (
          <span key={`${index}-${word.text}`} style={{ position: "relative", opacity: state.opacity }}>
            {word.text}
            {covered ? (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: "-0.1em",
                  bottom: "-0.1em",
                  left: "-0.16em",
                  right: "-0.16em",
                  padding: "0.1em 0.16em",
                  backgroundColor: tagColor,
                  color: tagTextColor,
                  clipPath: `inset(0 ${(1 - state.tagTo) * 100}% 0 ${state.tagFrom * 100}%)`,
                }}
              >
                {word.text}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
};

export type TypedHighlight = { text: string; at: number; frames?: number; slant?: boolean };

type TypedLineProps = TypingOptions & {
  text: string;
  highlights?: readonly TypedHighlight[];
  highlightColor?: string;
  caretColor?: string;
  /** Draw a selection box with handles and layout guides around the line. */
  box?: boolean;
  boxColor?: string;
  boxFill?: string;
  style?: React.CSSProperties;
};

/** Text typed in bursts. The box grows in steps with the letters; highlights sweep over finished words on their cues. */
export const TypedLine: React.FC<TypedLineProps> = ({
  text,
  at,
  seed,
  pace,
  pauses,
  highlights = [],
  highlightColor = "rgba(255,255,255,0.3)",
  caretColor = "currentColor",
  box = false,
  boxColor = "currentColor",
  boxFill,
  style,
}) => {
  const frame = useCurrentFrame();
  const schedule = typingSchedule(text, { at, seed, pace, pauses });
  if (frame < at) return null;
  const count = typedCount(frame, schedule);
  const shown = [...text].slice(0, count).join("");
  const lastKey = count > 0 ? schedule[count - 1]! : at;
  const caretOn = frame - lastKey < 8 || Math.floor(frame / 15) % 2 === 0;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const highlight of [...highlights].sort((a, b) => text.indexOf(a.text) - text.indexOf(b.text))) {
    const start = text.indexOf(highlight.text);
    if (start < 0 || start >= shown.length) continue;
    if (start > cursor) parts.push(shown.slice(cursor, start));
    const end = Math.min(start + highlight.text.length, shown.length);
    const sweep = progress(frame, highlight.at, highlight.frames ?? 6, "inOut");
    const slant = highlight.slant ? progress(frame, highlight.at + 3, 5, "expoOut") : 0;
    parts.push(
      <span
        key={highlight.text}
        style={{
          position: "relative",
          display: "inline-block",
          transform: slant ? `skewX(${-11 * slant}deg)` : undefined,
        }}
      >
        {sweep > 0 ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: "0.02em",
              bottom: "0.02em",
              left: "-0.06em",
              right: "-0.06em",
              backgroundColor: highlightColor,
              clipPath: `inset(0 ${(1 - sweep) * 100}% 0 0)`,
            }}
          />
        ) : null}
        <span style={{ position: "relative" }}>{shown.slice(start, end)}</span>
      </span>,
    );
    cursor = end;
  }
  if (cursor < shown.length) parts.push(shown.slice(cursor));
  const handle = (left: boolean, top: boolean) => (
    <span
      key={`${left}-${top}`}
      aria-hidden
      style={{
        position: "absolute",
        width: 10,
        height: 10,
        backgroundColor: boxColor,
        [left ? "left" : "right"]: -5,
        [top ? "top" : "bottom"]: -5,
      }}
    />
  );
  const guides = progress(frame, at, 14, "expoOut");
  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        whiteSpace: "pre",
        minHeight: "1.3em",
        minWidth: "0.8em",
        lineHeight: 1.3,
        padding: box ? "0.08em 0.28em" : undefined,
        backgroundColor: box ? boxFill : undefined,
        ...style,
      }}
    >
      {box ? (
        <>
          <span aria-hidden style={{ position: "absolute", inset: 0, border: `1.5px solid ${boxColor}` }} />
          {[true, false].flatMap((left) => [true, false].map((top) => handle(left, top)))}
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: -2400 * guides,
              right: -2400 * guides,
              height: 1,
              backgroundColor: boxColor,
              opacity: 0.24,
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              bottom: 0,
              left: -2400 * guides,
              right: -2400 * guides,
              height: 1,
              backgroundColor: boxColor,
              opacity: 0.24,
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: -1400 * guides,
              bottom: -1400 * guides,
              width: 1,
              backgroundColor: boxColor,
              opacity: 0.24,
            }}
          />
          <span
            aria-hidden
            style={{
              position: "absolute",
              right: 0,
              top: -1400 * guides,
              bottom: -1400 * guides,
              width: 1,
              backgroundColor: boxColor,
              opacity: 0.24,
            }}
          />
        </>
      ) : null}
      <span style={{ position: "relative" }}>{parts}</span>
      {caretOn ? (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: "0.06em",
            height: "1em",
            marginLeft: "0.05em",
            verticalAlign: "-0.12em",
            backgroundColor: caretColor,
          }}
        />
      ) : null}
    </div>
  );
};

type NumberRaceProps = RaceOptions & {
  /** Digit height in pixels: also the font size. */
  size: number;
  /** Characters of the settled number's grouping, inserted every three digits. */
  separator?: string;
  /** Columns at rest; defaults to the digits of `to`. */
  columns?: number;
  maxBlurDigits?: number;
  style?: React.CSSProperties;
  element?: string;
};

/** An odometer: reels in clipped columns, smudged by their own speed, stopping from the left as the value's curve slows. */
export const NumberRace: React.FC<NumberRaceProps> = ({
  size,
  separator = " ",
  columns,
  maxBlurDigits = 1.2,
  style,
  element,
  ...race
}) => {
  const frame = useCurrentFrame();
  const count = columns ?? String(Math.floor(race.to)).length;
  const value = raceValue(frame, race);
  const reels = odometerReels(value, count);
  const nextReels = odometerReels(raceValue(frame + 1, race), count);
  const height = size * 1.08;
  return (
    <div
      data-element={element}
      aria-label={String(Math.round(race.to))}
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: size,
        lineHeight: `${height}px`,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "pre",
        ...style,
      }}
    >
      {reels.map((reel, column) => {
        const fromRight = count - 1 - column;
        const digit = Math.floor(reel) % 10;
        const offset = reel - Math.floor(reel);
        const leading = value < 10 ** fromRight && fromRight > 0;
        const pace = Math.min(Math.abs(nextReels[column]! - reel), maxBlurDigits) * height;
        return (
          <React.Fragment key={column}>
            <div
              style={{
                position: "relative",
                width: "0.66em",
                height,
                overflow: "hidden",
                opacity: leading ? 0 : 1,
                textAlign: "center",
              }}
            >
              <Smear
                vy={pace}
                rows={false}
                seed={column + 1}
                options={{ shutter: 0.3, stretchPer100: 0, chromaPer100: 0, maxBlur: size * 0.2 }}
                style={{ display: "block" }}
              >
                <div style={{ transform: `translateY(${-offset * height}px)` }}>
                  <div>{digit}</div>
                  <div>{(digit + 1) % 10}</div>
                </div>
              </Smear>
            </div>
            {fromRight > 0 && fromRight % 3 === 0 ? (
              <span style={{ opacity: leading ? 0 : 1, width: "0.26em" }} aria-hidden>
                {separator}
              </span>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
};

type SliceWordProps = {
  at: number;
  /** Where the cut crosses the left and right edge, as a share of height. */
  cut?: readonly [number, number];
  /** Pixels the lower piece slides along the cut. */
  slide?: number;
  frames?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

/** A word cut along a line on a cue, the pieces sliding apart. Pair it with a `LightPath` drawn along the same line. */
export const SliceWord: React.FC<SliceWordProps> = ({
  at,
  cut = [0.72, 0.28],
  slide = 70,
  frames = 8,
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const t = progress(frame, at, frames, "expoOut");
  if (t <= 0) return <div style={{ whiteSpace: "pre", ...style }}>{children}</div>;
  const [left, right] = cut;
  const fall = ((left - right) * 0.5 + 0.1) * slide * t;
  return (
    <div style={{ position: "relative", whiteSpace: "pre", ...style }}>
      <div
        style={{
          clipPath: `polygon(-5% -30%, 105% -30%, 105% ${right * 100}%, -5% ${left * 100}%)`,
          transform: `translate(${-slide * 0.35 * t}px, ${-fall * 0.35}px)`,
        }}
      >
        {children}
      </div>
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          clipPath: `polygon(-5% ${left * 100}%, 105% ${right * 100}%, 105% 130%, -5% 130%)`,
          transform: `translate(${slide * t}px, ${fall}px)`,
        }}
      >
        {children}
      </div>
    </div>
  );
};

type EchoWordProps = {
  text: string;
  /** Pixels per frame of drift; give two echoes opposite signs. */
  drift: number;
  color: string;
  strokeWidth?: number;
  opacity?: number;
  style?: React.CSSProperties;
};

/**
 * An outline ghost of a word that drifts behind it: a mid layer that costs little and adds depth. The outline comes from
 * the silhouette, not `text-stroke`, because stroking a variable font draws its overlapping inner contours.
 */
export const EchoWord: React.FC<EchoWordProps> = ({ text, drift, color, strokeWidth = 2, opacity = 0.35, style }) => {
  const frame = useCurrentFrame();
  const id = useId().replaceAll(":", "");
  return (
    <div
      aria-hidden
      data-element="echo-word"
      style={{
        whiteSpace: "pre",
        color,
        filter: `url(#${id})`,
        opacity,
        transform: `translateX(${frame * drift}px)`,
        ...style,
      }}
    >
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
        <filter id={id} x="-2%" y="-5%" width="104%" height="110%" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceGraphic" operator="dilate" radius={strokeWidth} result="grown" />
          <feComposite in="grown" in2="SourceGraphic" operator="out" />
        </filter>
      </svg>
      {text}
    </div>
  );
};
