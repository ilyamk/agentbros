import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";
import { EDUCATION_STAGES, type EducationRequest } from "../src/types/workflow-education";
export function educationFixture(long = false) {
  const root = mkdtempSync(path.join(tmpdir(), "education-workflow-"));
  const ff = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  writeFileSync(
    path.join(root, "source.md"),
    "A proportion compares a part with a whole. Nonzero whole. 2 divided by 4 equals 0.5.\n",
  );
  for (const [id, color] of [
    ["diagram", "teal"],
    ["example", "orange"],
  ])
    ff(["-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-frames:v", "1", path.join(root, `${id}.png`)]);
  const duration = long ? 300 : 12;
  ff([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:duration=${duration}`,
    "-c:a",
    "pcm_s16le",
    path.join(root, "voice.wav"),
  ]);
  ff([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=110:duration=${duration}`,
    "-c:a",
    "pcm_s16le",
    path.join(root, "music.wav"),
  ]);
  const file = (name: string) => ({
    file: name,
    sha256: hashFile(path.join(root, name)),
  });
  const frameLength = long ? 450 : 30;
  const request: EducationRequest = {
    version: 1,
    projectId: "education-demo",
    title: "Proportions",
    audience: "Beginners",
    objective: "Compare part and whole",
    language: "en",
    formats: ["landscape"],
    sources: [{ id: "primer", title: "Supplied teaching note", ...file("source.md") }],
    claims: [
      {
        id: "ratio",
        text: "A proportion compares a part with a whole.",
        basis: "direct",
        evidence: [
          {
            sourceId: "primer",
            excerpt: "A proportion compares a part with a whole.",
            locator: "First sentence",
          },
        ],
        limitations: ["Nonzero whole."],
      },
      {
        id: "arithmetic",
        text: "2 divided by 4 equals 0.5.",
        basis: "direct",
        evidence: [
          {
            sourceId: "primer",
            excerpt: "2 divided by 4 equals 0.5.",
            locator: "Third sentence",
          },
        ],
        limitations: ["Nonzero whole."],
      },
    ],
    media: [
      { id: "diagram", kind: "image" as const, ...file("diagram.png") },
      { id: "example", kind: "image" as const, ...file("example.png") },
      { id: "voice", kind: "audio" as const, ...file("voice.wav") },
      { id: "music", kind: "audio" as const, ...file("music.wav") },
    ].map((m) => ({
      ...m,
      provenance: {
        origin: "manual" as const,
        tool: "synthetic-test",
        model: "unknown",
        referenceAssetIds: [],
        billing: { status: "unknown" as const },
      },
      rights: {
        licence: "test fixture",
        commercialAllowed: false,
        attributionRequired: false,
      },
    })),
    music: { mediaId: "music", sourceStartFrame: 0, loop: false, volume: 0.25 },
    chapters: [0, 1, long ? 2 : undefined]
      .filter((i): i is number => i !== undefined)
      .map((ch) => ({
        id: `chapter-${ch}`,
        title: `Lesson ${ch + 1}`,
        beats: EDUCATION_STAGES.map((stage, i) => {
          const spokenText = `A proportion compares a part with a whole. ${stage === "worked-example" ? "2 divided by 4 equals 0.5. " : ""}Nonzero whole.`;
          return {
            id: `beat-${ch}-${i}`,
            stage,
            headline: stage === "worked-example" ? "2 ÷ 4 = 0.5" : stage === "recap" ? "Part / whole" : stage,
            spokenText,
            claimIds: stage === "worked-example" ? ["ratio", "arithmetic"] : ["ratio"],
            visualId: i % 2 ? "example" : "diagram",
            visualStartFrame: 0,
            voiceId: "voice",
            sourceStartFrame: (ch * 6 + i) * frameLength,
            durationFrames: frameLength,
            captions: spokenText.split(" ").map((text, j, words) => ({
              text,
              startFrame: Math.floor((j * frameLength) / words.length),
              endFrame: Math.floor(((j + 1) * frameLength) / words.length),
            })),
            context: ["Nonzero whole."],
          };
        }),
      })),
  };
  return {
    root,
    request,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
