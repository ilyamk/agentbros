import React from "react";

/** Opaque sections of a turned metal ring, projected back to front. Separating
 * the sections exposes their milled edges; closing them restores the silhouette. */
export function TurnedRing({
  x,
  y,
  size,
  pose,
  spread,
  tint,
}: {
  x: number;
  y: number;
  size: number;
  pose: number;
  spread: number;
  tint: string;
}) {
  const pieces = 72,
    edges = 28;
  const pitch = 0.72 + 0.31 * Math.sin(pose),
    roll = -0.58 + 0.34 * Math.cos(pose * 0.85);
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch),
    cr = Math.cos(roll),
    sr = Math.sin(roll);
  const project = (a: number, b: number, c: number) => {
    const depth = b * sp + c * cp;
    const flat = b * cp - c * sp;
    const lens = 3.9 / (3.9 - depth);
    return { x: (a * cr - flat * sr) * lens, y: (a * sr + flat * cr) * lens, z: depth };
  };
  const sections = Array.from({ length: pieces }, (_, i) => {
    const a = (2 * Math.PI * i) / pieces;
    const ca = Math.cos(a),
      sa = Math.sin(a),
      twist = 0.28 * Math.sin(2 * a + pose);
    const r = 0.58 + spread * 0.16 * Math.cos(2 * a + pose);
    const lift = spread * 0.56 * Math.sin(2 * a + pose);
    const points = Array.from({ length: edges }, (_, j) => {
      const t = (2 * Math.PI * j) / edges;
      const rr = r + 0.27 * Math.cos(t + twist);
      const p = project(rr * ca, rr * sa, lift + 0.27 * Math.sin(t + twist));
      return `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    }).join(" ");
    return {
      points,
      depth: project(r * ca, r * sa, lift).z,
      i,
      light: 0.44 + 0.52 * Math.max(0, Math.cos(a + pose * 0.52 - 0.5)),
    };
  }).sort((a, b) => a.depth - b.depth);
  return (
    <svg
      aria-hidden
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        overflow: "visible",
      }}
      viewBox="-1.04 -1.04 2.08 2.08"
    >
      <defs>
        <linearGradient id="turned-metal" x1="0%" y1="85%" x2="86%" y2="0%">
          <stop stopColor="#1a2028" />
          <stop offset=".18" stopColor="#626973" />
          <stop offset=".34" stopColor="#eff2e9" />
          <stop offset=".41" stopColor={tint} />
          <stop offset=".52" stopColor="#727782" />
          <stop offset=".71" stopColor="#232731" />
          <stop offset=".84" stopColor="#f4f7ea" />
          <stop offset="1" stopColor="#9097a2" />
        </linearGradient>
      </defs>
      {sections.map(({ points, i, light }) => (
        <polygon
          key={i}
          points={points}
          fill="url(#turned-metal)"
          stroke={i % 3 === 0 ? "#f3f0dd" : "#282a31"}
          strokeOpacity={light}
          strokeWidth=".0038"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
