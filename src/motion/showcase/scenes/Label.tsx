import React from "react";
import { AbsoluteFill } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../../lib/fonts-cyrillic";
import { VelocityBlur } from "../../fx";
import { useFittedFontSize } from "../../text";
import { ember, label as labelPaper, roast } from "../palette";

export const LABEL_SIDE = 72;
const COLUMN = 1920 - LABEL_SIDE * 2;
const WEIGHT = 800;
const ROW_LINE = 0.86;

export type LabelFonts = { head: number; row: number };

/** One label design across the film: the head fills the column, and the longest date line sets the row size. */
export const useLabelFonts = (): LabelFonts | null => {
  const head = useFittedFontSize({
    text: "ОБЖАРЕН",
    withinWidth: COLUMN,
    fontFamily: cyrillicCondensedFont,
    fontWeight: WEIGHT,
  });
  const row = useFittedFontSize({
    text: "214 ДНЕЙ НАЗАД",
    withinWidth: COLUMN - 70,
    fontFamily: cyrillicCondensedFont,
    fontWeight: WEIGHT,
  });
  return head === null || row === null ? null : { head, row };
};

type LabelProps = {
  fonts: LabelFonts;
  /** The date drum: lines in order, and the fractional line now in the window. */
  strip: readonly string[];
  position: number;
  /** Lines per frame, for the blur. */
  speed?: number;
  footerLeft: string;
  footerRight?: string;
  aside?: React.ReactNode;
  ground?: string;
  ink?: string;
  dateInk?: string;
};

/** Laid out at 1920 x 1080 so it can fill the frame, and scaled down when it is a sticker on a pack. */
export const Label: React.FC<LabelProps> = ({
  fonts,
  strip,
  position,
  speed = 0,
  footerLeft,
  footerRight,
  aside,
  ground = labelPaper,
  ink = roast,
  dateInk = ember,
}) => {
  const rowHeight = fonts.row * ROW_LINE;
  const top = 42;
  const headHeight = fonts.head * 0.8;
  const rowTop = top + headHeight + 22;
  return (
    <AbsoluteFill style={{ backgroundColor: ground, color: ink, width: 1920, height: 1080, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: LABEL_SIDE,
          top,
          fontFamily: cyrillicCondensedFont,
          fontWeight: WEIGHT,
          fontSize: fonts.head,
          lineHeight: 0.8,
          whiteSpace: "pre",
        }}
      >
        ОБЖАРЕН
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: rowTop - 12,
          height: rowHeight + 24,
          overflow: "hidden",
        }}
      >
        <VelocityBlur axis="y" speed={speed * rowHeight} maxBlur={70}>
          {strip.map((line, i) => {
            if (Math.abs(i - position) > 1.2) return null;
            return (
              <div
                key={line}
                style={{
                  position: "absolute",
                  left: LABEL_SIDE,
                  top: 12 + (i - position) * rowHeight,
                  fontFamily: cyrillicCondensedFont,
                  fontWeight: WEIGHT,
                  fontSize: fonts.row,
                  lineHeight: ROW_LINE,
                  color: dateInk,
                  whiteSpace: "pre",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {line}
              </div>
            );
          })}
        </VelocityBlur>
      </div>
      {aside}
      <div
        style={{
          position: "absolute",
          left: LABEL_SIDE,
          right: LABEL_SIDE,
          bottom: 66,
          display: "flex",
          justifyContent: "space-between",
          fontFamily: cyrillicGroteskFont,
          fontWeight: 600,
          fontSize: 62,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          whiteSpace: "pre",
        }}
      >
        <span>{footerLeft}</span>
        {footerRight ? <span>{footerRight}</span> : null}
      </div>
    </AbsoluteFill>
  );
};
