import { modelShotSchema, assemblySchema, type ModelShotProps } from "./shot-plan";

const shot = (props: Partial<ModelShotProps>) => modelShotSchema.parse(props);

export const projectorStage = shot({ background: "#142e3e", orbitDegrees: 74, fill: 0.8 });

export const connectorReveal = shot({
  background: "#15303b",
  camera: {
    points: [
      [-0.39, 0.29, 1.01],
      [0.03, 0.24, 0.95],
      [0.23, 0.1, 0.68],
    ],
    target: [0, 0, 0],
    targetEnd: [0.76, -0.19, 0.4],
    startFrame: 22,
    endFrame: 104,
  },
});

export const releaseBattery = shot({
  durationInFrames: 120,
  background: "#182940",
  orbitDegrees: 24,
  fill: 0.8,
  clip: { name: "release-battery", startFrame: 28, endFrame: 83 },
});

export const airPath = shot({
  background: "#162e33",
  fill: 0.77,
  camera: {
    points: [
      [-0.23, 0.24, 1.04],
      [0.27, 0.28, 0.98],
      [0.94, 0.25, 0.42],
      [0.59, 0.23, -0.89],
      [-0.22, 0.26, -1.02],
    ],
    target: [0, 0.02, 0],
    startFrame: 42,
    endFrame: 110,
  },
  highlights: [
    { node: "Air Intake", startFrame: 15, endFrame: 62 },
    { node: "Fan", startFrame: 87, endFrame: 114 },
    { node: "Exhaust", startFrame: 115, endFrame: 149 },
  ],
});

export const opticalWindow = shot({
  background: "#163547",
  fill: 0.79,
  orbitDegrees: 32,
  glass: { startFrame: 59, endFrame: 113, roughness: 0.34, control: false },
});

export const cellAssembly = assemblySchema.parse({});
