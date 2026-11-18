import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";
import type { ProductAdRequest } from "../src/types/workflow-product-ad";
export function productAdFixture(root: string): ProductAdRequest {
  const source = path.join(root, "supplied originals");
  mkdirSync(source, {
    recursive: true,
  });
  const ff = (args: string[]) =>
    execFileSync("ffmpeg", ["-v", "error", ...args], {
      timeout: 30000,
    });
  const hero = path.join(source, "product.png"),
    problem = path.join(source, "problem.png"),
    demo = path.join(source, "interaction.mp4"),
    voice = path.join(source, "spoken.wav"),
    music = path.join(source, "music.wav");
  for (const [file, color] of [
    [hero, "#E9EFEF"],
    [problem, "#B9BFCF"],
  ])
    ff([
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=480x480`,
      "-vf",
      "drawbox=x=180:y=180:w=120:h=120:color=#466CFF:t=fill",
      "-frames:v",
      "1",
      file,
    ]);
  ff([
    "-f",
    "lavfi",
    "-i",
    "color=c=#E9EFEF:s=480x480:r=30:d=5",
    "-vf",
    "drawbox=x=180:y=180:w=120:h=120:color=#466CFF:t=fill,drawbox=x=215:y=215:w=50:h=50:color=lime:t=fill:enable='gte(t,0.5)'",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    demo,
  ]);
  // Explicit synthetic technical acceptance audio; no claim that tones are real spoken words.
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-af", "volume=0.1", voice]);
  ff(["-f", "lavfi", "-i", "sine=frequency=110:duration=5", "-af", "volume=0.05", music]);
  const evidence = path.join(source, "claim.txt");
  writeFileSync(
    evidence,
    "SYNTHETIC FIXTURE: selecting the central action turns the result indicator green. This proves only local workflow rendering.",
  );
  const media = (
    [
      ["hero", hero, "image"],
      ["problem", problem, "image"],
      ["demo", demo, "video"],
      ["voice", voice, "audio"],
      ["music", music, "audio"],
    ] as const
  ).map(([id, file, kind]) => ({
    id,
    path: file,
    sha256: hashFile(file),
    kind,
    provenance: {
      origin: "manual" as const,
      tool: "Synthetic local acceptance fixture",
      model: "unknown",
      referenceAssetIds: [],
      billing: {
        status: "unknown" as const,
      },
    },
    rights: {
      licence: "SYNTHETIC TEST ONLY",
      commercialAllowed: false,
      attributionRequired: false,
    },
    ...(kind !== "audio"
      ? {
          criticalRegion: {
            x: 0.42,
            y: 0.42,
            width: 0.16,
            height: 0.16,
          },
        }
      : {}),
  }));
  const roles = ["hook", "problem", "demo", "proof", "cta"] as const;
  return {
    version: 1,
    kind: "product-ad",
    projectId: "synthetic-product-ad",
    productName: "Synthetic product",
    audience: "Local technical acceptance only",
    cta: {
      label: "Try the action",
      url: "https://example.invalid/demo",
    },
    style: {
      accent: "#D4E0FF",
      background: "#F0F0F0",
      text: "#FFFFFF",
    },
    media,
    claims: [
      {
        id: "visible-action",
        statement: "Result indicator becomes green",
        evidence: {
          path: evidence,
          sha256: hashFile(evidence),
          excerpt: "selecting the central action turns the result indicator green",
          reviewer: "SYNTHETIC TEST DECLARATION",
          reviewedAt: "2026-10-11T00:00:00Z",
        },
      },
    ],
    beats: roles.map((role, i) => ({
      id: role,
      role,
      durationFrames: 30,
      headline:
        role === "cta"
          ? "Try the action"
          : ["One useful action", "Before the change", "Select the action", "Result indicator becomes green"][i],
      ...(role === "cta"
        ? {
            subtext: "https://example.invalid/demo",
          }
        : {}),
      spokenText: "CAPTION",
      visual: {
        mediaId: role === "problem" ? "problem" : role === "demo" || role === "proof" ? "demo" : "hero",
        sourceStartFrame: role === "proof" ? 30 : 0,
        ...(role === "demo"
          ? {
              interaction: {
                action: "Select central button in synthetic UI",
                visibleOutcome: "Green result indicator appears",
                startFrame: 0,
                endFrame: 30,
              },
            }
          : {}),
      },
      voice: {
        mediaId: "voice",
        sourceStartFrame: i * 30,
        words: [
          {
            text: "CAPTION",
            startFrame: 4,
            endFrame: 27,
          },
        ],
      },
      claimIds: role === "proof" ? ["visible-action"] : [],
      framingNotes: "Synthetic UI central critical region stays visible in all three center-cover formats",
    })),
    music: {
      mediaId: "music",
      sourceStartFrame: 0,
      volume: 0.3,
    },
  };
}
