import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";

export const printRegistrationSchema = z.object({
  title: z.string().min(1).max(27),
  line: z.string().min(1).max(40),
  at: z.number().int().nonnegative(),
  step: z.number().int().min(3),
  passFrames: z.number().int().min(5),
  paper: z.string(),
  inks: z.tuple([z.string(), z.string(), z.string(), z.string()]),
});
export type PrintRegistrationProps = z.infer<typeof printRegistrationSchema>;
export const printRegistrationDefaults = {
  title: "Agent Bros. Pictures",
  line: "FROM ROUGH CUT TO RELEASE",
  at: 0,
  step: 6,
  passFrames: 13,
  paper: "#F1EDE1",
  inks: ["#149EB4", "#CB427A", "#DDB74B", "#182620"],
} satisfies PrintRegistrationProps;
export const printPassState = (frame: number, pass: number, p: PrintRegistrationProps) => {
  const at = p.at + pass * p.step;
  const reveal = progress(frame, at, p.passFrames, "drift");
  const lock = progress(frame, p.at + 3 * p.step, p.passFrames, "drift");
  return { reveal, offset: (pass - 1.5) * (9 - 7 * lock), lock };
};
export const printRegistrationCues = (p: PrintRegistrationProps): Cue[] => [
  { frame: p.at, kind: "reveal", sfx: "none", label: "First ink pass" },
  { frame: p.at + 3 * p.step + p.passFrames, kind: "land", sfx: "tick", label: "Registration locks" },
];

const Plate: React.FC<{ p: PrintRegistrationProps; ink: string; index: number }> = ({ p, ink, index }) => (
  <svg width="100%" height="100%" viewBox="0 0 1600 900" aria-hidden>
    {Array.from({ length: 16 }, (_, i) => (
      <ellipse
        key={i}
        cx={1120 + i * 4}
        cy={364 + i}
        rx={290 - i * 13}
        ry={188 - i * 9}
        transform="rotate(-18 1150 395)"
        stroke={ink}
        fill="none"
        strokeWidth={i % 5 === 0 ? 3 : 1.4}
      />
    ))}
    <text
      x="114"
      y="600"
      fontFamily="Georgia, serif"
      fontSize={Math.min(124, 1930 / p.title.length)}
      letterSpacing="-4"
      fill={ink}
    >
      {p.title}
    </text>
    {index === 3 ? (
      <text x="119" y="677" fill={ink} fontFamily="Arial, sans-serif" fontSize="26" fontWeight="700" letterSpacing="6">
        {p.line}
      </text>
    ) : null}
    <path
      d="M117 203v-54h52m1310 0h-52m52 0v54M117 723v46h52m1310 0h-52m52 0v-46"
      stroke={ink}
      strokeWidth="1.7"
      fill="none"
    />
  </svg>
);
export const PrintRegistration: React.FC<PrintRegistrationProps> = (p) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: p.paper, isolation: "isolate", overflow: "hidden" }}>
      <svg viewBox="0 0 1600 900" width="100%" height="100%" style={{ position: "absolute", inset: 0 }} aria-hidden>
        <path
          d="M117 203v-54h52m1310 0h-52m52 0v54M117 723v46h52m1310 0h-52m52 0v-46"
          stroke={p.inks[3]}
          opacity="0.24"
          strokeWidth="1.1"
          fill="none"
        />
      </svg>
      {p.inks.map((ink, index) => {
        const { reveal, offset, lock } = printPassState(frame, index, p);
        return (
          <AbsoluteFill
            key={index}
            style={{
              clipPath: `inset(0 ${(1 - reveal) * 100}% 0 0)`,
              transform: `translate(${offset}px,${-offset * 0.42}px)`,
              opacity: index === 3 ? 1 : 0.74 - 0.43 * lock,
              mixBlendMode: "multiply",
            }}
          >
            <Plate p={p} ink={ink} index={index} />
          </AbsoluteFill>
        );
      })}
    </AbsoluteFill>
  );
};
