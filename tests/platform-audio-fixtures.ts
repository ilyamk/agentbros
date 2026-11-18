import { DeliveryRequestSchema, type RenderIdentity } from "../src/types/delivery";
import { AssetRegistrySchema } from "../src/types/assets";
import { ResourceCandidateSchema } from "../src/types/resources";
import { ProjectVideoSchema } from "../src/lib/project-props";
import { type PlatformAudioPlacement } from "../src/types/platform-audio";
import { deliveryUseContext } from "../src/lib/delivery/use-context";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import {
  nativeSelectionHash,
  nativeMarksHash,
  nativeSpanHash,
  platformAudioHash,
} from "../src/lib/delivery/platform-audio-plan";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const zero = "0".repeat(64),
  now = "2026-10-12T00:00:00Z";
export function platformFixture(root: string) {
  const project = path.join(root, "public/projects/demo");
  fs.mkdirSync(path.join(project, "pipeline/evidence"), { recursive: true });
  const body = "Explicit synthetic source-evidence bytes; no authenticated platform or music rights proof";
  const evidenceFile = "pipeline/evidence/native.json";
  fs.writeFileSync(path.join(project, evidenceFile), body);
  const evidence = { file: evidenceFile, sha256: sha(body) };
  const original = Buffer.from("not audio: CPU-only original hash fixture");
  const hash = sha(original),
    source = `projects/demo/assets/imported/${hash}.bin`;
  fs.mkdirSync(path.dirname(path.join(root, "public", source)), { recursive: true });
  fs.writeFileSync(path.join(root, "public", source), original);
  const registry = AssetRegistrySchema.parse({
    schemaVersion: 1,
    revision: 1,
    assets: [
      {
        schemaVersion: 1,
        id: "sha256:" + hash,
        hash,
        revision: 1,
        createdAt: now,
        kind: "audio",
        files: { original: source, bytes: original.length, mime: "application/octet-stream" },
        media: { codec: "fixture-no-decoder", durationSec: 10, hasAudio: true },
        rights: {
          licence: "CC0",
          commercialAllowed: true,
          attributionRequired: false,
          sourceUrl: "https://example.test/fixture",
          checkedAsOf: now,
        },
        provenance: { origin: "manual" },
        status: "candidate",
      },
    ],
  });
  const timeline = {
    version: 1,
    projectId: "demo",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "title",
            assetId: "scene:title",
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" },
            captions: [],
            payload: {
              scene: {
                id: "title",
                text: "Protected speech",
                visualType: "title",
                headline: "Simple",
                durationInFrames: 90,
              },
            },
          },
        ],
      },
      {
        id: "speech",
        kind: "voiceover",
        clips: [
          {
            id: "voice",
            assetId: "sha256:" + hash,
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" },
            captions: [
              { id: "caption", text: "Protected speech", start: { num: 0, den: 1 }, end: { num: 90, den: 1 } },
            ],
          },
        ],
      },
    ],
  };
  const props = ProjectVideoSchema.parse({
    projectId: "demo",
    format: "landscape",
    productName: "CPU",
    tagline: "CPU-only fixture",
    accentColor: "#000000",
    bgColor: "#000000",
    textColor: "#ffffff",
    musicVolume: 0,
    voiceoverEnabled: true,
    captionsEnabled: false,
    scenes: [],
    timeline,
    timelineAssets: { ["sha256:" + hash]: { source, kind: "audio", durationSec: 10, hasAudio: true } },
  });
  const config = path.join(project, "project.json");
  fs.writeFileSync(config, "{}");
  const journal = path.join(project, "pipeline/timeline-edit.json");
  fs.writeFileSync(journal, JSON.stringify({ version: 1, revision: 0, timeline: props.timeline, undo: [], redo: [] }));
  const registryFile = path.join(project, "pipeline/asset-registry.json");
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  const identity: RenderIdentity = {
    version: 1,
    projectId: "demo",
    format: "landscape",
    captions: "off",
    compositionId: "demo-landscape",
    durationInFrames: 90,
    propsHash: platformAudioHash(props),
    sourceSnapshotHash: zero,
    storyHash: zero,
    editRevision: 0,
    sources: [
      { path: path.relative(root, journal), sha256: sha(fs.readFileSync(journal)), role: "edit" },
      { path: path.relative(root, config), sha256: sha("{}"), role: "config" },
      { path: "public/" + source, sha256: hash, role: "asset" },
    ],
  };
  const request = DeliveryRequestSchema.parse({
      version: 1,
      projectId: "demo",
      timeline: true,
      formats: ["landscape"],
      variants: ["clean"],
      placements: ["tiktok"],
      loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
    }),
    use = deliveryUseContext(root, request, [identity]);
  const review = {
    reviewedBy: "Fixture reviewer",
    reviewedAt: now,
    note: "Explicit fixture declaration only; not legal or semantic evidence",
    evidence,
  };
  const resource = ResourceCandidateSchema.parse({
    id: "fixture-track",
    provider: "tiktok-cml",
    kind: "audio",
    title: "Declared native track",
    sourceUrl: "https://example.test/native-track",
    author: "Declared",
    acquisition: "native-platform",
    media: { durationSec: 20 },
    rights: {
      licence: "Supplied track terms",
      commercialAllowed: true,
      derivativesAllowed: true,
      attributionRequired: false,
      attributionText: "",
      allowedPlacements: ["tiktok"],
      restrictions: [],
      evidenceUrl: "https://example.test/native-terms",
      checkedAsOf: now,
      verifiedAtSource: true,
    },
    cost: { status: "unknown" },
  });
  const entry = {
    id: "native-1",
    platform: "tiktok",
    resource,
    target: { format: "landscape", variant: "clean", placement: "tiktok" },
    territory: "US",
    account: { kind: "business", identifier: "declared-fixture-account" },
    clock: "seconds-rational-v1",
    sourceOffset: { num: 1, den: 2 },
    videoStart: { num: 0, den: 1 },
    videoEnd: { num: 3, den: 1 },
    trackDuration: { num: 20, den: 1 },
    evidence: { selection: evidence, licence: evidence, territoryAccount: evidence },
    marks: [
      { id: "beat", videoTime: { num: 1, den: 2 }, trackTime: { num: 1, den: 1 }, label: "Reviewed fixture mark" },
    ],
    selectionReview: {
      ...review,
      decision: "declared-suitable-for-manual-placement",
      selectionHash: zero,
      usageContextSha256: use.contextSha256,
    },
    marksReview: { ...review, selectionHash: zero, marksHash: zero },
  } as PlatformAudioPlacement["entries"][number];
  entry.selectionReview.selectionHash = nativeSelectionHash(entry);
  entry.marksReview.selectionHash = entry.selectionReview.selectionHash;
  entry.marksReview.marksHash = nativeMarksHash(entry);
  const compiled = compileTimelineIR(props.timeline!),
    clip = compiled.tracks.find((track) => track.id === "speech")!.clips[0];
  const plan: PlatformAudioPlacement = {
    version: 1,
    entries: [entry],
    sourceReviews: [
      {
        ...review,
        musicContent: "declared-absent",
        trackId: "speech",
        clipId: "voice",
        assetSha256: hash,
        spanHash: nativeSpanHash("speech", "voiceover", clip),
        role: "speech",
      },
    ],
    outputReviews: [],
  };
  request.platformAudioPlacement = plan;
  return {
    root,
    project,
    request,
    use,
    props,
    identity,
    registry,
    plan,
    entry,
    evidence,
    review,
    journal,
    config,
    registryFile,
    originalFile: path.join(root, "public", source),
  };
}
