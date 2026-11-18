import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont } from "../../../lib/fonts-cyrillic";
import { FilmGrain } from "../../fx";
import { progress, track, velocity } from "../../timing";
import { ember, label, roast } from "../palette";
import { Label, useLabelFonts } from "./Label";

const BRAND_AT = 66;
const STRIP = ["12 НОЯБРЯ", "2 ДНЯ НАЗАД"];

const DRUM = (f: number): number =>
  track(f, [
    { at: 42, value: 0 },
    { at: 60, value: 1.04, curve: "inOut" },
    { at: 68, value: 1, curve: "expoOut" },
  ]);

/** The opening poster again, with the same words and the sum changed. The last frame holds. */
export const Ending: React.FC = () => {
  const frame = useCurrentFrame();
  const fonts = useLabelFonts();
  if (fonts === null) return <AbsoluteFill style={{ backgroundColor: ember }} />;
  return (
    <AbsoluteFill style={{ backgroundColor: ember }}>
      <Label
        fonts={fonts}
        strip={STRIP}
        position={DRUM(frame)}
        speed={velocity(DRUM, frame)}
        footerLeft="Партия №2: заказы до 18 ноября, 23:59"
        ground={ember}
        ink={roast}
        dateInk={label}
        aside={
          frame >= BRAND_AT ? (
            <div
              style={{
                position: "absolute",
                right: 72,
                top: 838,
                fontFamily: cyrillicGroteskFont,
                letterSpacing: "-0.03em",
                color: roast,
                textAlign: "right",
                whiteSpace: "pre",
                clipPath: `inset(-20px -20px -20px ${(1 - progress(frame, BRAND_AT, 14)) * 100}%)`,
              }}
            >
              <div style={{ fontSize: 96, fontWeight: 800, lineHeight: 1.04 }}>«Четверг»</div>
              <div style={{ fontSize: 62, fontWeight: 600, lineHeight: 1.1 }}>обжарочная</div>
            </div>
          ) : null
        }
      />
      <FilmGrain seed="ending" opacity={0.08} />
    </AbsoluteFill>
  );
};
