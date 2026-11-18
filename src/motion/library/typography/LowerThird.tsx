import React from "react";
import { z } from "zod";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { PreviewFootage } from "../captions/kit";
import { groteskFace, serifFace } from "./faces";
import { useSharedFit } from "./fit";
import { LOWER_THIRD_IN, LOWER_THIRD_OUT, LOWER_THIRD_STAGGER, lowerThirdTimes } from "./lower-third-plan";
import { ARRIVE, EXIT, Stage, useSafeArea } from "./Stage";

export { lowerThirdCues, lowerThirdTimes } from "./lower-third-plan";

export const lowerThirdSchema = z.object({
  /** The person's name exactly as approved. */
  name: z.string().min(1),
  role: z.string(),
  /** Joined to the role with a middle dot; empty for none. */
  company: z.string(),
  /** Logo under public/, e.g. "projects/x/assets/logo.png"; empty for none. Drawn at the name's cap height. */
  logo: z.string(),
  look: z.enum(["bar", "outline", "editorial"]),
  /** `dark` reads over dark or busy footage (dark plate, light ink); `light` over bright footage. */
  tone: z.enum(["dark", "light"]),
  accent: z.string(),
  align: z.enum(["left", "right"]),
  /** `bottom` sits on the safe area's lower edge; `top` for vertical films whose captions hold the lower band. */
  anchor: z.enum(["bottom", "top"]),
  /** Extra pixels away from the anchored edge, e.g. to clear a caption line. */
  lift: z.number().min(0),
  /** A soft shade under the text on the anchored side, for bright or busy footage. */
  scrim: z.boolean(),
  /** "transparent" over footage (timeline overlays, scenes); "preview" paints a stand-in for footage; any other value is a flat ground colour. */
  ground: z.string(),
  inAt: z.number().int().min(0),
  /** Frame the exit starts; -1 holds to the end of the clip. */
  outAt: z.number().int(),
});

export type LowerThirdProps = z.infer<typeof lowerThirdSchema>;

const INK = {
  dark: { ink: "#FAFAF7", muted: "rgba(250,250,247,0.72)", plate: "rgba(14,14,16,0.86)" },
  light: { ink: "#111111", muted: "rgba(17,17,17,0.66)", plate: "rgba(250,250,247,0.94)" },
};

const Ground: React.FC<{ ground: string; children: React.ReactNode }> = ({ ground, children }) =>
  ground === "preview" ? (
    <PreviewFootage tone="cool">{children}</PreviewFootage>
  ) : (
    <Stage background={ground} grain={0}>
      {children}
    </Stage>
  );

const ease = (frame: number, from: number, duration: number, curve: (t: number) => number) =>
  interpolate(frame, [from, from + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: curve,
  });

/**
 * A name-and-role overlay over footage, transparent everywhere else. Bar: an accent bar and a solid plate wiping out from
 * it. Outline: a hairline frame with no fill. Editorial: an accent rule and the name in a serif. Dead still while held.
 */
export const LowerThird: React.FC<LowerThirdProps> = (p) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const t = lowerThirdTimes(p.inAt, p.outAt);
  const { ink, muted, plate } = INK[p.tone];
  const editorial = p.look === "editorial";
  const face = editorial ? serifFace : groteskFace;
  const weight = editorial ? 400 : 600;
  const canvasWidth = safe.width + safe.side * 2;
  const nameMax = Math.round((safe.vertical ? 50 : canvasWidth * 0.026) * (editorial ? 1.3 : 1));
  const roleSize = Math.max(28, Math.round(nameMax * (editorial ? 0.46 : 0.6)));
  const maxWidth = safe.width * (safe.vertical ? 0.86 : 0.55);
  const fitted = useSharedFit(
    [{ text: p.name, fontFamily: face, fontWeight: weight, letterSpacing: editorial ? "-0.01em" : "-0.02em" }],
    maxWidth,
    nameMax,
  );
  if (fitted === null) return <Ground ground={p.ground}>{null}</Ground>;
  const nameSize = fitted;

  const enter = (delay: number) => ease(frame, t.inAt + delay, LOWER_THIRD_IN, ARRIVE);
  const leave = t.outAt === null ? 0 : ease(frame, t.outAt, LOWER_THIRD_OUT, EXIT);
  if (frame < t.inAt || (t.gone !== null && frame >= t.gone)) return <Ground ground={p.ground}>{null}</Ground>;

  const lead = enter(LOWER_THIRD_STAGGER.lead);
  const nameIn = enter(LOWER_THIRD_STAGGER.name);
  const roleIn = enter(LOWER_THIRD_STAGGER.role);
  const logoIn = enter(LOWER_THIRD_STAGGER.logo);
  const textOut = Math.min(1, leave * 1.6);
  const rise = nameSize * 0.5;
  const lineStyle = (p0: number, travel: number): React.CSSProperties => ({
    opacity: p0 * (1 - textOut),
    transform: `translateY(${(1 - p0) * travel + textOut * -travel * 0.3}px)`,
  });

  const right = p.align === "right";
  const roleLine = [p.role, p.company].filter((s) => s.trim() !== "").join(" · ");
  const shadow =
    p.look === "bar"
      ? undefined
      : `0 1px 2px rgba(0,0,0,${p.tone === "dark" ? 0.35 : 0}), 0 0 12px rgba(0,0,0,${p.tone === "dark" ? 0.16 : 0})`;
  const position: React.CSSProperties = {
    position: "absolute",
    [right ? "right" : "left"]: safe.side,
    [p.anchor === "top" ? "top" : "bottom"]:
      (p.anchor === "top" ? safe.top : safe.vertical ? safe.bottom : Math.round(safe.bottom * 1.1)) + p.lift,
    display: "flex",
    flexDirection: right ? "row-reverse" : "row",
    alignItems: "stretch",
    maxWidth: maxWidth + nameSize * 3,
  };

  const name = (
    <div style={{ overflow: "hidden", paddingBottom: nameSize * 0.08 }}>
      <div
        style={{
          fontFamily: face,
          fontWeight: weight,
          fontSize: nameSize,
          lineHeight: 1.1,
          letterSpacing: editorial ? "-0.01em" : "-0.02em",
          color: ink,
          whiteSpace: "nowrap",
          textShadow: shadow,
          ...lineStyle(nameIn, rise),
        }}
      >
        {p.name}
      </div>
    </div>
  );
  const role = roleLine ? (
    <div
      style={{
        fontFamily: groteskFace,
        fontWeight: editorial ? 600 : 500,
        fontSize: roleSize,
        lineHeight: 1.2,
        marginTop: nameSize * (editorial ? 0.22 : 0.12),
        letterSpacing: editorial ? "0.12em" : "-0.005em",
        textTransform: editorial ? "uppercase" : undefined,
        color: muted,
        maxWidth,
        textShadow: shadow,
        ...lineStyle(roleIn, rise * 0.6),
      }}
    >
      {roleLine}
    </div>
  ) : null;
  const logo = p.logo ? (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        [right ? "marginRight" : "marginLeft"]: nameSize * 0.6,
        [right ? "paddingRight" : "paddingLeft"]: nameSize * 0.6,
        [right ? "borderRight" : "borderLeft"]: `1px solid ${muted}`,
        opacity: logoIn * (1 - textOut),
      }}
    >
      <Img src={staticFile(p.logo)} style={{ height: nameSize * 0.9, width: "auto", display: "block" }} />
    </div>
  ) : null;
  const text = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: right ? "flex-end" : "flex-start",
        textAlign: right ? "right" : "left",
      }}
    >
      {name}
      {role}
    </div>
  );

  const wipe = (amount: number) =>
    right ? `inset(0 0 0 ${(1 - amount) * 100}%)` : `inset(0 ${(1 - amount) * 100}% 0 0)`;
  const scrimOpacity = p.scrim ? lead * (1 - leave) : 0;
  const scrim = p.scrim ? (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${p.anchor === "top" ? "180deg" : "0deg"}, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.22) 22%, rgba(0,0,0,0) 42%)`,
        opacity: scrimOpacity,
      }}
    />
  ) : null;

  let body: React.ReactNode;
  if (p.look === "bar") {
    const plateIn = enter(LOWER_THIRD_STAGGER.lead + 2);
    body = (
      <div style={position}>
        <div
          style={{
            width: Math.max(5, nameSize * 0.12),
            backgroundColor: p.accent,
            transform: `scaleY(${lead * (1 - leave)})`,
            transformOrigin: "bottom",
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: right ? "row-reverse" : "row",
            alignItems: "center",
            backgroundColor: plate,
            padding: `${nameSize * 0.36}px ${nameSize * 0.55}px`,
            clipPath: wipe(plateIn * (1 - leave)),
          }}
        >
          {text}
          {logo}
        </div>
      </div>
    );
  } else if (p.look === "outline") {
    const frameIn = enter(LOWER_THIRD_STAGGER.lead);
    body = (
      <div style={position}>
        <div
          style={{
            display: "flex",
            flexDirection: right ? "row-reverse" : "row",
            alignItems: "center",
            padding: `${nameSize * 0.36}px ${nameSize * 0.55}px`,
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              border: `2px solid ${ink}`,
              borderRadius: 4,
              clipPath: wipe(frameIn * (1 - leave)),
              boxShadow: p.tone === "dark" ? "0 0 12px rgba(0,0,0,0.25)" : undefined,
            }}
          />
          {text}
          {logo}
        </div>
      </div>
    );
  } else {
    body = (
      <div style={{ ...position, flexDirection: "column", alignItems: right ? "flex-end" : "flex-start" }}>
        <div
          style={{
            width: nameSize * 1.6,
            height: Math.max(2, Math.round(nameSize * 0.05)),
            backgroundColor: p.accent,
            marginBottom: nameSize * 0.32,
            transform: `scaleX(${lead * (1 - leave)})`,
            transformOrigin: right ? "right" : "left",
          }}
        />
        <div style={{ display: "flex", flexDirection: right ? "row-reverse" : "row", alignItems: "center" }}>
          {text}
          {logo}
        </div>
      </div>
    );
  }

  return (
    <Ground ground={p.ground}>
      {scrim}
      {body}
    </Ground>
  );
};

export const lowerThirdDefaults: LowerThirdProps = {
  name: "Maya Torres",
  role: "Head of Finance",
  company: "Fieldwork Studio",
  logo: "",
  look: "bar",
  tone: "dark",
  accent: "#3D6BF5",
  align: "left",
  anchor: "bottom",
  lift: 0,
  scrim: false,
  ground: "preview",
  inAt: 10,
  outAt: 116,
};
