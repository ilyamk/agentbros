import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../../lib/fonts-cyrillic";
import { FittedLine, MaskedLine } from "../../text";
import { progress } from "../../timing";
import { ember, kraft, label, roast } from "../palette";

const DAYS = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];
const CELL = 1776 / DAYS.length;
const DAY_LEFT = [72, 690, 1000];
const COPY_AFTER_MONDAY = 1010;

const Calendar: React.FC<{ active: number; ink: string; mark: string }> = ({ active, ink, mark }) => (
  <div style={{ position: "absolute", left: 72, right: 72, top: 54, display: "flex" }}>
    {DAYS.map((day, i) => (
      <div
        key={day}
        style={{
          width: CELL,
          borderTop: `6px solid ${i === active ? mark : ink}`,
          paddingTop: 12,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 700,
          fontSize: 52,
          color: i === active ? mark : ink,
          opacity: i === active ? 1 : 0.42,
        }}
      >
        {day}
      </div>
    ))}
  </div>
);

type DayProps = { index: number; ground: string; ink: string; mark: string; kg: string; flip?: boolean };

/** The week walks across the frame on the beat: each day sits under its own column, so a cut also moves the layout. */
const Day: React.FC<DayProps> = ({ index, ground, ink, mark, kg, flip }) => {
  const frame = useCurrentFrame();
  const bump = 1 + 0.03 * (1 - progress(frame, 0, 8));
  const dayLeft = DAY_LEFT[index]!;
  const textStyle: React.CSSProperties = { position: "absolute", top: 760, whiteSpace: "pre" };
  const copyLeft = flip ? 72 : COPY_AFTER_MONDAY;
  return (
    <AbsoluteFill style={{ backgroundColor: ground, color: ink, overflow: "hidden" }}>
      <Calendar active={index} ink={ink} mark={mark} />
      <div
        style={{
          position: "absolute",
          left: dayLeft,
          top: 136,
          fontFamily: cyrillicCondensedFont,
          fontWeight: 900,
          fontSize: 960,
          lineHeight: 0.92,
          color: mark,
          transform: `scale(${bump})`,
          transformOrigin: "0 100%",
          whiteSpace: "pre",
        }}
      >
        {DAYS[index]}
      </div>
      <div
        style={{
          ...textStyle,
          top: 300,
          left: copyLeft,
          fontFamily: cyrillicCondensedFont,
          fontWeight: 800,
          fontSize: 230,
          lineHeight: 0.88,
        }}
      >
        {"НЕ\nЖАРИМ"}
      </div>
      <div
        style={{
          ...textStyle,
          top: 760,
          left: copyLeft,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 700,
          fontSize: 92,
          lineHeight: 1.05,
          letterSpacing: "-0.03em",
        }}
      >{`${kg}\nзаказано`}</div>
    </AbsoluteFill>
  );
};

export const Monday: React.FC = () => <Day index={0} ground={roast} ink={label} mark={label} kg="2,4 кг" />;
export const Tuesday: React.FC = () => <Day index={1} ground={kraft} ink={roast} mark={roast} kg="5,1 кг" flip />;
export const Wednesday: React.FC = () => <Day index={2} ground={label} ink={roast} mark={roast} kg="8,6 кг" flip />;

const THURSDAY = "ЧЕТВЕРГ";

/** The turn: the one day that is not a "no". The word is the brand. */
export const Thursday: React.FC = () => {
  const frame = useCurrentFrame();
  const heavy = progress(frame, 0, 10);
  return (
    <AbsoluteFill style={{ backgroundColor: ember, color: roast }}>
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 60,
          transform: `scale(${0.975 + 0.025 * progress(frame, 0, 126, "linear")})`,
          transformOrigin: "0 0",
        }}
      >
        <FittedLine text={THURSDAY} withinWidth={1776} fontFamily={cyrillicCondensedFont} fontWeight={900}>
          {(fontSize) => (
            <MaskedLine
              reveal={heavy}
              lineHeight={0.8}
              style={{ fontFamily: cyrillicCondensedFont, fontWeight: 900, fontSize, color: label }}
            >
              {THURSDAY}
            </MaskedLine>
          )}
        </FittedLine>
      </div>
      <div
        style={{
          position: "absolute",
          left: 72,
          top: 764,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 700,
          fontSize: 108,
          letterSpacing: "-0.035em",
        }}
      >
        {frame >= 22 ? (
          <MaskedLine reveal={progress(frame, 22, 16)} lineHeight={1.12}>
            Жарим один день в неделю.
          </MaskedLine>
        ) : null}
        {frame >= 58 ? (
          <MaskedLine reveal={progress(frame, 58, 16)} lineHeight={1.12}>
            Только то, что уже заказали.
          </MaskedLine>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
