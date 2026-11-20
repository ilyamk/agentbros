import React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { progress } from "../../timing";
import { TurnedRing } from "./TurnedRing";
import { GroundSwap } from "../transitions/GroundSwap";
import { growShape } from "../transitions/CausedMorph";
import { condensedFace, groteskFace, serifFace } from "../typography/faces";
import { useSharedFit } from "../typography/fit";
import { CaptureProof, type CaptureProofProps } from "./CaptureProof";
import { CUT, specimenRing } from "./transition-cut-plan";

const ink = "#171820",
  chalk = "#f2eedf",
  acid = "#d7ff42",
  lilac = "#b8a0ff";
const edge = 0.056;

function Title({ lines, size, colour, shift = 0 }: { lines: string[]; size: number; colour: string; shift?: number }) {
  return (
    <div
      style={{
        fontFamily: condensedFace,
        fontSize: size,
        lineHeight: 0.94,
        letterSpacing: "-.036em",
        textTransform: "uppercase",
        color: colour,
      }}
    >
      {lines.map((line, i) => (
        <div key={i} style={{ transform: `translateX(${shift * (i % 2 ? -1 : 1)}px)` }}>
          {line}
        </div>
      ))}
    </div>
  );
}

function Imprint({ left, right, colour }: { left: string; right: string; colour: string }) {
  const { width, height } = useVideoConfig();
  const s = Math.min(width, height);
  return (
    <div
      style={{
        position: "absolute",
        left: width * edge,
        right: width * edge,
        top: s * 0.065,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderTop: `2px solid ${colour}`,
        paddingTop: s * 0.012,
        fontFamily: groteskFace,
        fontWeight: 600,
        fontSize: s * 0.028,
        color: colour,
        letterSpacing: "-.02em",
      }}
    >
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}

function Opening({ brand }: { brand: string }) {
  const f = useCurrentFrame();
  const { width: w, height: h } = useVideoConfig();
  const v = h > w,
    s = Math.min(w, h);
  const align = progress(f, 0, 13, "expoOut");
  const split = progress(f, 33, 12, "expoIn");
  const poster = (
    <div
      style={{
        position: "absolute",
        left: w * edge,
        top: h * (v ? 0.265 : 0.24),
        fontFamily: condensedFace,
        fontSize: v ? w * 0.64 : h * 0.61,
        letterSpacing: "-.052em",
        lineHeight: 1,
        color: chalk,
      }}
    >
      CUT.
    </div>
  );
  return (
    <AbsoluteFill style={{ background: ink, overflow: "hidden" }}>
      <Imprint left={brand} right="Transitions" colour={chalk} />
      <div
        style={{
          position: "absolute",
          left: w * edge,
          top: h * (v ? 0.185 : 0.16),
          fontSize: s * 0.086,
          fontFamily: serifFace,
          fontStyle: "italic",
          color: acid,
        }}
      >
        Find the
      </div>
      {[0, 1, 2].map((i) => {
        const sign = i === 1 ? 1 : -1;
        const x = sign * ((1 - align) * s * (0.18 + i * 0.07) + split * w * (0.7 + i * 0.13));
        const a = [0, v ? 37 : 38, v ? 48 : 59, 100];
        return (
          <AbsoluteFill
            key={i}
            style={{ clipPath: `inset(${a[i]}% 0 ${100 - a[i + 1]!}% 0)`, transform: `translateX(${x}px)` }}
          >
            {poster}
          </AbsoluteFill>
        );
      })}
      <TurnedRing
        x={v ? w * 0.59 : w * 0.767}
        y={v ? h * 0.72 : h * 0.53}
        size={s * (v ? 0.9 : 1.07)}
        pose={f * 0.035 + 0.3}
        spread={0.06 + split * 0.68}
        tint={acid}
      />
    </AbsoluteFill>
  );
}

function Specimen({ second }: { second: boolean }) {
  const f = useCurrentFrame();
  const { width: w, height: h } = useVideoConfig();
  const s = Math.min(w, h),
    v = h > w;
  const cuts = second ? [0] : [0, CUT.invert - CUT.first, CUT.return - CUT.first];
  const grounds = second
    ? [{ ground: lilac, ink }]
    : [
        { ground: acid, ink },
        { ground: ink, ink: acid },
        { ground: chalk, ink },
      ];
  return (
    <GroundSwap cuts={cuts} grounds={grounds} kick={0.045}>
      {(shot) => {
        const impact = 1 - progress(shot.local, 0, 10);
        const close = second ? progress(f, CUT.open - CUT.second, CUT.lock - CUT.open, "linear") : 0;
        const radius = s * 0.056;
        const ring = specimenRing(w, h);
        const { x: cx, y: cy } = ring;
        const disc = growShape(
          "orb",
          { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 },
          close,
          "sine.in",
          w,
          h,
        );
        return (
          <AbsoluteFill style={{ overflow: "hidden" }}>
            <Imprint left="Transitions" right={second ? "02 / 02" : "01 / 02"} colour={shot.ink} />
            <div style={{ position: "absolute", left: w * edge, top: h * (v ? 0.185 : 0.294) }}>
              <Title
                colour={shot.ink}
                size={v ? w * 0.225 : h * 0.25}
                lines={second ? ["Caused", "morph"] : ["Ground-", "swap cut"]}
                shift={impact * s * 0.085}
              />
            </div>
            <TurnedRing
              {...ring}
              pose={second ? 1.8 + f * 0.024 : 0.82 + f * 0.028 + shot.index * 0.52}
              spread={second ? 1.15 * (1 - progress(f, 6, 36, "drift")) : 0.12 + impact * 0.72}
              tint={second ? "#e5d9ff" : shot.index === 1 ? acid : "#99ac51"}
            />
            {second ? (
              <div
                style={{
                  position: "absolute",
                  background: ink,
                  left: disc.cx - disc.width / 2,
                  top: disc.cy - disc.height / 2,
                  width: disc.width,
                  height: disc.height,
                  borderRadius: "50%",
                }}
              />
            ) : null}
          </AbsoluteFill>
        );
      }}
    </GroundSwap>
  );
}

function Closing({ brand, action }: { brand: string; action: string }) {
  const f = useCurrentFrame(),
    { width: w, height: h } = useVideoConfig(),
    s = Math.min(w, h);
  const words = brand.trim().split(/\s+/);
  const label = useSharedFit(
    words.map((text) => ({ text, fontFamily: condensedFace, fontWeight: 400 })),
    w * 0.78,
    s * 0.27,
  );
  const p = progress(f, 0, 13);
  return (
    <AbsoluteFill style={{ background: ink, justifyContent: "center", paddingLeft: w * edge }}>
      <div style={{ transform: `translateY(${(1 - p) * s * 0.12}px)`, opacity: p }}>
        <Title lines={words} size={label ?? s * 0.22} colour={chalk} />
        <div style={{ marginTop: s * 0.045, fontFamily: groteskFace, fontSize: s * 0.046, color: acid }}>{action}</div>
      </div>
    </AbsoluteFill>
  );
}

/** The two matched catalogue items perform their own transitions after the real filter action. */
export function TransitionCut({
  proof,
  brand,
  action,
  styleId,
  audio,
}: {
  proof: CaptureProofProps;
  brand: string;
  action: string;
  styleId: string;
  audio?: string;
}) {
  return (
    <AbsoluteFill style={{ background: ink }}>
      <Sequence durationInFrames={CUT.proof}>
        <Opening brand={brand} />
      </Sequence>
      <Sequence from={CUT.proof} durationInFrames={CUT.first - CUT.proof}>
        <CaptureProof cutToGround proof={proof} styleId={styleId} length={CUT.first - CUT.proof} />
      </Sequence>
      <Sequence from={CUT.first} durationInFrames={CUT.second - CUT.first}>
        <Specimen second={false} />
      </Sequence>
      <Sequence from={CUT.second} durationInFrames={CUT.lock - CUT.second}>
        <Specimen second />
      </Sequence>
      <Sequence from={CUT.lock}>
        <Closing brand={brand} action={action} />
      </Sequence>
      {audio ? <Audio src={staticFile(audio)} /> : null}
    </AbsoluteFill>
  );
}
