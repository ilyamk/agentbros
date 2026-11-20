import { loadFont } from "@remotion/fonts";
import React from "react";
import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from "remotion";

/** Generated TrueType font with glyphs only for A-Z and space, so Cyrillic must fall back. */
const LATIN_ONLY_TTF =
  "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";
void loadFont({ family: "LatinOnly", format: "truetype", url: `data:font/ttf;base64,${LATIN_ONLY_TTF}` });

const Label: React.FC<{ x: number; y: number; size?: number; font?: string; opacity?: number; children: React.ReactNode }> = ({ x, y, size = 20, font = "sans-serif", opacity = 1, children }) => (
  <div style={{ position: "absolute", left: x, top: y, fontSize: size, fontFamily: font, lineHeight: 1, color: "white", whiteSpace: "nowrap", opacity }}>{children}</div>
);
const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => <AbsoluteFill style={{ backgroundColor: "#123456" }}>{children}</AbsoluteFill>;
const Box: React.FC<{ x: number }> = ({ x }) => <div style={{ position: "absolute", left: x, top: 150, width: 20, height: 20, backgroundColor: "#ffcc00" }} />;

/** Holds the patterns that must not count: a crossfade, a mask reveal, a stroke-and-fill stack and a tight headline. */
const Clean: React.FC = () => {
  const frame = useCurrentFrame();
  const swap = interpolate(frame, [10, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Stage>
      <Label x={10} y={10} font="LatinOnly">HELLO</Label>
      <Label x={10} y={40} opacity={1 - swap}>Outgoing words</Label>
      <Label x={10} y={40} opacity={swap}>Incoming words</Label>
      <div style={{ position: "absolute", left: 10, top: 70, width: 100, height: 24, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: interpolate(frame, [0, 29], [40, 0]), fontSize: 20, fontFamily: "sans-serif", color: "white" }}>Masked</div>
      </div>
      <Label x={150} y={10}>Layered</Label>
      <Label x={150} y={10}>Layered</Label>
      <Label x={150} y={70} size={40}>Tight</Label>
      <Label x={150} y={106} size={40}>nose</Label>
      <Box x={frame * 2} />
    </Stage>
  );
};

const LoopGood: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Stage>
      <Label x={10} y={10}>Loop</Label>
      <Box x={100 + Math.round(50 * Math.sin((2 * Math.PI * frame) / 20))} />
    </Stage>
  );
};

const BrokenSeam: React.FC = () => (
  <Stage>
    <Label x={10} y={10}>Loop</Label>
    <Box x={useCurrentFrame() * 2} />
  </Stage>
);

const Overlap: React.FC = () => (
  <Stage>
    <Label x={10} y={10}>First line of text</Label>
    <Label x={20} y={14}>Second line of text</Label>
  </Stage>
);

const OffStage: React.FC = () => (
  <Stage>
    <Label x={250} y={10}>This sentence runs off the right edge</Label>
  </Stage>
);

const Region: React.FC = () => (
  <Stage>
    <div data-region="headline" style={{ position: "absolute", left: 10, top: 10, width: 60, height: 30 }}>
      <Label x={0} y={0}>Far too long for its panel</Label>
    </div>
  </Stage>
);

const SafeZone: React.FC = () => (
  <Stage>
    <Label x={100} y={40} size={60}>Under the status bar</Label>
  </Stage>
);

const Random: React.FC = () => (
  <Stage>
    <Label x={10} y={10}>Random</Label>
    <Box x={Math.floor(Math.random() * 300)} />
  </Stage>
);

const Fallback: React.FC = () => (
  <Stage>
    <Label x={10} y={10} font="LatinOnly, sans-serif">Привет</Label>
  </Stage>
);

const FadedFinal: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "black" }}>
    <AbsoluteFill style={{ backgroundColor: "white", opacity: interpolate(useCurrentFrame(), [14, 29], [1, 0.2], { extrapolateLeft: "clamp" }) }}>
      <div style={{ position: "absolute", left: 10, top: 10, fontSize: 20, fontFamily: "sans-serif", color: "black" }}>Goodbye</div>
    </AbsoluteFill>
  </AbsoluteFill>
);

const BlackFrame: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame >= 10 && frame < 15) return <AbsoluteFill style={{ backgroundColor: "black" }} />;
  return (
    <Stage>
      <Label x={10} y={10}>Flash</Label>
    </Stage>
  );
};

/** Light and dark swap every two frames until frame 24: eleven full-frame transitions in a second. */
const Strobe: React.FC = () => {
  const frame = useCurrentFrame();
  const dark = frame < 24 && Math.floor(frame / 2) % 2 === 1;
  return (
    <AbsoluteFill style={{ backgroundColor: dark ? "#202020" : "#f0f0f0" }}>
      <Label x={10} y={10}>Strobe</Label>
    </AbsoluteFill>
  );
};

const Throws: React.FC = () => {
  if (useCurrentFrame() >= 10) throw new Error("Deliberate fixture failure");
  return (
    <Stage>
      <Label x={10} y={10}>Throws</Label>
    </Stage>
  );
};

const ConsoleError: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame === 5) console.error("Deliberate fixture console error");
  return (
    <Stage>
      <Label x={10} y={10}>Console</Label>
    </Stage>
  );
};

let visitedFirstFrame = false;
const OnlyInSequence: React.FC = () => {
  const frame = useCurrentFrame();
  if (frame === 0) visitedFirstFrame = true;
  if (!visitedFirstFrame) throw new Error("Needs an earlier frame");
  return (
    <Stage>
      <Label x={10} y={10}>Sequence</Label>
    </Stage>
  );
};

/** Three lines rising and fading in together, the same way, from frame 3: no order. */
const SlopEntry: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = interpolate(frame, [3, 13], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Stage>
      <Label x={200} y={10}>Brand</Label>
      {["Fast", "Smart", "Secure"].map((word, index) => (
        <div key={word} style={{ position: "absolute", left: 10, top: 10 + index * 40, fontSize: 20, fontFamily: "sans-serif", lineHeight: 1, color: "white", opacity: rise, transform: `translateY(${(1 - rise) * 20}px)` }}>
          {word}
        </div>
      ))}
    </Stage>
  );
};

/** One headline on the centre line in every frame. */
const SlopCentred: React.FC = () => (
  <Stage>
    <div style={{ position: "absolute", left: 0, right: 0, top: 70, fontSize: 24, fontFamily: "sans-serif", lineHeight: 1, color: "white", textAlign: "center" }}>Centred</div>
  </Stage>
);

const SlopEmoji: React.FC = () => (
  <Stage>
    <Label x={10} y={10}>Launch 🚀</Label>
  </Stage>
);

/** A violet-to-indigo ground and a frosted-glass card. */
const SlopPalette: React.FC = () => (
  <AbsoluteFill style={{ backgroundImage: "linear-gradient(135deg, #6366f1, #8b5cf6)" }}>
    <div id="card" style={{ position: "absolute", left: 160, top: 40, width: 120, height: 80, backgroundColor: "rgba(255, 255, 255, 0.15)", backdropFilter: "blur(12px)" }} />
    <Label x={10} y={10}>Palette</Label>
  </AbsoluteFill>
);

const small = { width: 320, height: 180, fps: 30, durationInFrames: 30 };
const ReadabilityFixture: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });
  const background = frame < 30 ? "#666" : "#999";
  return (
    <AbsoluteFill style={{ background }}>
      <div style={{ position: "absolute", left: 9, top: 8, fontSize: 22, color: "#888" }}>Низкий контраст</div>
      <div style={{ position: "absolute", left: 9, top: 43, fontSize: 24, color: "#fff", background: "#000", opacity }}>Readable fade</div>
      <div style={{ position: "absolute", left: 9, top: 92, fontSize: 5, color: "#fff" }}>Tiny label</div>
      {frame >= 18 && frame <= 24 && <Label x={9} y={118}>A message to read</Label>}
      <Box x={frame} />
    </AbsoluteFill>
  );
};
const fixtures: Record<string, React.FC> = { Clean, LoopGood, BrokenSeam, Overlap, OffStage, Region, Random, Fallback, FadedFinal, BlackFrame, Strobe, Throws, ConsoleError, OnlyInSequence, SlopEntry, SlopCentred, SlopEmoji, SlopPalette };

const Root: React.FC = () => (
  <>
    {Object.entries(fixtures).map(([id, component]) => (
      <Composition key={id} id={id} component={component} {...small} />
    ))}
    <Composition id="SafeZone" component={SafeZone} width={1080} height={1920} fps={30} durationInFrames={6} />
    <Composition id="ReadabilityFixture" component={ReadabilityFixture} {...small} durationInFrames={60} />
  </>
);

registerRoot(Root);
