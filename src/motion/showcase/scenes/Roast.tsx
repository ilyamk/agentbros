import { Video } from "@remotion/media";
import React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../../lib/fonts-cyrillic";
import { FittedLine } from "../../text";
import { ember, greenBean, label, roast } from "../palette";

type CardProps = { ground: string; ink: string; title: string; detail: string; accent: string };

const Card: React.FC<CardProps> = ({ ground, ink, title, detail, accent }) => (
  <AbsoluteFill style={{ backgroundColor: ground, color: ink }}>
    <div style={{ position: "absolute", left: 72, top: 96 }}>
      <FittedLine text={title} withinWidth={1776} fontFamily={cyrillicCondensedFont} fontWeight={800} />
    </div>
    <div
      style={{
        position: "absolute",
        left: 72,
        bottom: 96,
        fontFamily: cyrillicGroteskFont,
        fontWeight: 700,
        fontSize: 112,
        letterSpacing: "-0.035em",
        color: accent,
        whiteSpace: "pre",
      }}
    >
      {detail}
    </div>
  </AbsoluteFill>
);

/** Rendered as stills and handed to the Hyperframes shader, so the dissolve runs between this film's own frames. */
export const RoastGreen: React.FC = () => (
  <Card ground={greenBean} ink={roast} title="ЗЕЛЁНОЕ ЗЕРНО" detail="12 кг. Четверг, 06:40" accent={roast} />
);
export const RoastDark: React.FC = () => (
  <Card ground="#120B06" ink={label} title="ПЕРВЫЙ КРЭК" detail="196°. Четверг, 06:52" accent={ember} />
);

export const Roast: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: greenBean }}>
    <Video src={staticFile("motion-lab/showcase/roast-shader.mp4")} muted style={{ width: "100%", height: "100%" }} />
  </AbsoluteFill>
);
