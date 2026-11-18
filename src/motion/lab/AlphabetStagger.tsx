import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { MaskedLine } from "../text";
import { splitGraphemes } from "../text-split";
import { progress, stagger, type Stagger } from "../timing";
import { bone, ink, signal } from "./palette";

const ALPHABET = splitGraphemes("АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ");
const COLUMNS = 11;
const ROWS = 3;
const PERIOD = 48;
/** Tighter than the default: capitals need less, and the bleed zone stays inside the gap between rows while letters travel. */
const BLEED = { top: 0.22, bottom: 0.16, side: 0.05 };
const SPECIAL = new Set(["Ё", "Й", "Щ", "Ц", "Д", "У"]);

const MODES: { label: string; map: Stagger }[] = [
  { label: "по индексу", map: { kind: "index", step: 0.4 } },
  { label: "от центра", map: { kind: "centre", step: 0.5 } },
  { label: "по сиду", map: { kind: "seeded", seed: "alphabet", step: 0.55, jitter: 2 } },
];

/** One alphabet, three stagger maps, the same reveal. It also proves the mask on every Cyrillic capital. */
export const AlphabetStagger: React.FC = () => {
  const frame = useCurrentFrame();
  const modeIndex = Math.min(Math.floor(frame / PERIOD), MODES.length - 1);
  const local = frame - modeIndex * PERIOD;
  const mode = MODES[modeIndex]!;
  const delays = stagger(ALPHABET.length, mode.map);
  const last = modeIndex === MODES.length - 1;
  return (
    <AbsoluteFill style={{ backgroundColor: bone, color: ink, padding: "48px 72px" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
          gridTemplateRows: `repeat(${ROWS}, 1fr)`,
          height: 880,
        }}
      >
        {ALPHABET.map((letter, i) => {
          const start = delays[i]!;
          const reveal = progress(local, start, 16) - (last ? 0 : progress(local, 32 + start * 0.2, 10, "expoIn"));
          return (
            <div key={letter} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
              <MaskedLine
                reveal={reveal}
                lineHeight={1}
                bleed={BLEED}
                style={{
                  fontFamily: cyrillicCondensedFont,
                  fontWeight: 800,
                  fontSize: 250,
                  color: SPECIAL.has(letter) ? signal : ink,
                }}
              >
                {letter}
              </MaskedLine>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 72,
          right: 72,
          bottom: 48,
          display: "flex",
          justifyContent: "space-between",
          fontFamily: cyrillicGroteskFont,
          fontWeight: 500,
          fontSize: 34,
        }}
      >
        <span>Задержка: {mode.label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {MODES.map((_, i) => (i === modeIndex ? "●" : "○")).join(" ")}
        </span>
      </div>
    </AbsoluteFill>
  );
};
