import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  planCampaign,
  createCampaignProjects,
  campaignCostReport,
  storeOutcome,
  assertCampaignReferences,
} from "../src/lib/campaigns";
import {
  planLocalization,
  createLocalizedProject,
  assertLocalizationReady,
  reviewLocalization,
} from "../src/lib/campaigns/localization";
import { saveEntityVersion, approveEntityVersion } from "../src/lib/entities/service";
import { conformDubbingAudio } from "../src/lib/elevenlabs/dubbing-conform";
import { importAsset, hashFile } from "../src/lib/assets/registry";
import { OperationStore } from "../src/lib/jobs/store";
import { USER_GRANT } from "./helpers/ceiling-grant";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "campaign-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "public/projects/world");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  const image = path.join(root, "ref.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=32x32", "-frames:v", "1", image]);
  const asset = importAsset({
    rootDir: root,
    projectId: "world",
    sourceFile: image,
    provenance: { origin: "agent-harness", tool: "Codex" },
  }).asset;
  const card = {
    kind: "object" as const,
    id: "product",
    name: "Product",
    description: "Approved product",
    createdBy: "creator",
    physical: { shape: "cube" },
    references: [{ assetId: asset.id, role: "front" }],
  };
  const version = saveEntityVersion("world", card, { rootDir: root }).version;
  const manifest = {
    version: 1,
    id: "series",
    revision: 1,
    capUsd: 10,
    brand: {
      revision: 1,
      name: "Brand",
      palette: { accent: "#ff0000", background: "#000000", text: "#ffffff" },
      rules: [],
    },
    world: {
      revision: 1,
      invariants: ["same product"],
      pins: [
        {
          sourceProjectId: "world",
          kind: "object",
          entityId: "product",
          revision: 1,
          contentHash: version.contentHash,
        },
      ],
    },
    episodes: ["one", "two"].map((id) => ({
      id,
      projectId: id,
      quotaUsd: 5,
      language: "ru",
      voice: "voice-original",
      recipe: { projectId: id, recipeId: "social-hook", topic: id },
    })),
  };
  return { root, directory, asset, card, manifest };
}
const approve = (root: string) =>
  approveEntityVersion(
    "world",
    "object",
    "product",
    1,
    {
      id: "creator",
      kind: "human",
      authorizationEvidence: "Supplied approval",
    },
    { rootDir: root, expectedRevision: 1 },
  );
test("campaign reuse pins exact approved entity and original; newer revisions don't replace it", (t) => {
  const f = fixture(t);
  assert.throws(() => planCampaign(f.manifest, f.root), /approval/);
  approve(f.root);
  const first = planCampaign(f.manifest, f.root);
  saveEntityVersion("world", { ...f.card, description: "New candidate" }, { rootDir: f.root, expectedRevision: 1 });
  assert.equal(planCampaign(f.manifest, f.root).manifestHash, first.manifestHash);
  assert.equal(first.pins[0].version.revision, 1);
  assert.throws(
    () =>
      planCampaign(
        {
          ...f.manifest,
          world: {
            ...f.manifest.world,
            pins: [{ ...f.manifest.world.pins[0], contentHash: "0".repeat(64) }],
          },
        },
        f.root,
      ),
    /hash mismatch/,
  );
  writeFileSync(path.join(f.root, "public", f.asset.files.original), "changed");
  assert.throws(() => planCampaign(f.manifest, f.root), /changed/);
});
test("batch creation keeps source pins/voice; bounds quota and refuses existing projects", (t) => {
  const f = fixture(t);
  approve(f.root);
  assert.throws(() => planCampaign({ ...f.manifest, capUsd: 9.99 }, f.root), /exceed/);
  const result = createCampaignProjects(f.manifest, f.root);
  assert.equal(result.outputs.length, 2);
  const snapshot = JSON.parse(
    readFileSync(path.join(f.root, "public/projects/one/pipeline/campaign-snapshot.json"), "utf8"),
  );
  assert.equal(snapshot.episode.language, "ru");
  assert.equal(snapshot.pins[0].version.referenceSnapshots[0].hash, f.asset.hash);
  assert.equal(JSON.parse(readFileSync(result.outputs[0], "utf8")).voice, "voice-original");
  const store = new OperationStore("one", {
    directory: path.join(f.root, "public/projects/one/pipeline"),
  });
  assert.throws(() => store.configure({ ceilingUsd: 5.01, maxJobUsd: 5 }, USER_GRANT), /campaign quota/);
  const report = campaignCostReport(f.manifest, f.root);
  assert.equal(report.actualUsd, 0);
  assert.equal(report.episodes[0].paidAttempts, 0);
  assert.equal(report.allocationIsSpend, false);
  store.reserveOperation({
    operationId: "fixture",
    provider: "mock",
    endpoint: "local",
    inputHash: "fixture",
    assetId: "test",
    quote: {
      currency: "USD",
      lowUsd: 0.5,
      expectedUsd: 0.5,
      highUsd: 1,
      bounded: true,
      source: "synthetic test quote",
      asOf: "2026-10-11",
      confidence: "user-bound",
    },
  });
  store.transitionJob("fixture", "submitting");
  store.reconcileBilling("fixture", {
    receiptId: "mock-receipt",
    actualUsd: 0.5,
    source: "local test fixture; not provider billing",
    confirmedAt: "2026-10-11T00:00:00Z",
  });
  assert.equal(campaignCostReport(f.manifest, f.root).actualUsd, 0.5);
  assert.equal(campaignCostReport(f.manifest, f.root).episodes[0].allocatedUsd, 5);
  assertCampaignReferences(path.join(f.root, "public/projects/one"), f.root);
  const bindingFile = path.join(f.root, "public/projects/one/pipeline/campaign-binding.json");
  const binding = readFileSync(bindingFile, "utf8");
  rmSync(bindingFile);
  assert.throws(() => store.configure({ ceilingUsd: 20, maxJobUsd: 20 }, USER_GRANT), /binding is missing/);
  writeFileSync(bindingFile, binding);
  const original = readFileSync(result.outputs[0], "utf8");
  assert.throws(() => createCampaignProjects(f.manifest, f.root), /already exists/);
  assert.equal(readFileSync(result.outputs[0], "utf8"), original);
});
const project = {
  name: "Source",
  productName: "Source",
  formats: ["landscape"],
  colors: {},
  scenes: [
    {
      id: "hook",
      text: "Original speech",
      headline: "Original",
      visualType: "title",
      durationInFrames: 120,
    },
  ],
};
const translation = {
  version: 1,
  sourceProjectId: "source",
  sourceLanguage: "en",
  targetLanguage: "ru",
  projectId: "localized",
  voice: "voice-ru",
  source: "Creator supplied translation",
  wordsPerSecond: 2.3,
  scenes: [
    {
      id: "hook",
      text: "Новая речь",
      headline: "Новый заголовок",
      captions: ["Новая речь"],
    },
  ],
};
test("localization requires supplied complete translations and invalidates speech/alignment", () => {
  const result = planLocalization(project, translation);
  assert.equal(result.audioStale, true);
  assert.equal(result.alignmentStale, true);
  assert.equal(result.timestampReuse, false);
  assert.equal(result.project.voice, "voice-ru");
  assert.throws(() => planLocalization(project, { ...translation, scenes: [] }));
  assert.throws(
    () =>
      planLocalization(project, {
        ...translation,
        scenes: [{ ...translation.scenes[0], text: Array(30).fill("слово").join(" ") }],
      }),
    /word budget/,
  );
  const embedded = planLocalization(
    {
      ...project,
      talkingHead: {
        enabled: true,
        presenterVideo: "projects/source/talking-head/full.mp4",
        audioSource: "embedded",
      },
    },
    { ...translation, scenes: [{ ...translation.scenes[0], text: "" }] },
  );
  assert.equal(embedded.audioStale, true);
  assert.equal(embedded.project.talkingHead!.presenterVideo, "projects/localized/talking-head/full.mp4");
});
test("localized readiness needs new local audio, alignment and explicit review; modified audio invalidates it", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "locale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "public/projects/source");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "project.json"), JSON.stringify(project));
  const result = createLocalizedProject(translation, root),
    dir = path.dirname(result.outputs[0]);
  assert.throws(() => assertLocalizationReady(dir), /review/);
  assert.throws(() => createLocalizedProject(translation, root));
  mkdirSync(path.join(dir, "voiceover"));
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=4", path.join(dir, "voiceover/hook.mp3")]);
  writeFileSync(
    path.join(dir, "voiceover/hook.words.json"),
    JSON.stringify([
      { text: "Новая", start: 0, end: 1 },
      { text: "речь", start: 1, end: 2 },
    ]),
  );
  reviewLocalization(dir, {
    reviewedBy: "creator",
    evidence: "Listened to supplied Russian take",
    expectedSourceHash: result.plan.sourceHash,
    audio: ["voiceover/hook.mp3"],
    alignments: ["voiceover/hook.words.json"],
  });
  assert.doesNotThrow(() => assertLocalizationReady(dir));
  writeFileSync(path.join(dir, "voiceover/hook.mp3"), "modified");
  assert.throws(() => assertLocalizationReady(dir), /changed/);
});
test("outcomes preserve supplied metrics/cohort/evidence without causal claims or overwrites", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "outcome-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "outcome.json");
  const outcome = {
    version: 1,
    campaignId: "series",
    episodeId: "one",
    observedAt: "2026-10-11T00:00:00Z",
    source: "manual export.csv",
    cohort: "Organic RU viewers",
    metrics: { views: 42 },
    review: { reviewedBy: "creator", evidence: "Dashboard export" },
  };
  storeOutcome(outcome, file);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.metrics.views, 42);
  assert.equal(saved.causalAttribution, "not-inferred");
  assert.throws(() => storeOutcome(outcome, file));
});

test("localisation pins the selected language and conformed renderer audio; stale dub blocks rendering", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "locale-dub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "public/projects/source");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "project.json"), JSON.stringify(project));
  const result = createLocalizedProject(translation, root),
    dir = path.dirname(result.outputs[0]);
  const dub = path.join(source, "dub.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=4", dub]);
  const binding = path.join(source, "dub.dubbing.json");
  const target = {
    operationId: "fixture",
    output: "public/projects/source/dub.wav",
    status: "completed",
    revision: 1,
    outputRevision: 1,
    selectedRevision: 1,
    selectedSourceRevision: 0,
    sha256: hashFile(dub),
  };
  const state = {
    version: 1,
    projectId: "source",
    operationId: "fixture",
    inputHash: "fixture",
    source: { file: target.output, sha256: hashFile(dub), durationSec: 4 },
    prepaidLanguage: "ru",
    sourceRevision: 0,
    targets: { ru: target, en: target },
    liveVerified: false,
  };
  writeFileSync(binding, JSON.stringify(state));
  const request = {
    version: 1,
    projectId: "localized",
    binding,
    targetLanguage: "ru",
    clips: [{ sceneId: "hook", startSec: 0, endSec: 4, output: "public/projects/localized/voiceover/hook.mp3" }],
  };
  assert.equal(conformDubbingAudio(request, { rootDir: root }).metadata.state, "planned");
  assert.equal(existsSync(path.join(dir, "voiceover/hook.mp3")), false);
  conformDubbingAudio(request, { rootDir: root, dryRun: false });
  conformDubbingAudio(request, { rootDir: root, dryRun: false });
  writeFileSync(
    path.join(dir, "voiceover/hook.words.json"),
    JSON.stringify({
      words: [
        { text: "Новая", start: 0, end: 1 },
        { text: "речь", start: 1, end: 2 },
      ],
    }),
  );
  const review = {
    reviewedBy: "Fixture reviewer",
    evidence: "Synthetic contract fixture; no human listening claim",
    expectedSourceHash: result.plan.sourceHash,
    audio: ["voiceover/hook.mp3"],
    alignments: ["voiceover/hook.words.json"],
    dubbing: { binding, language: "ru" },
  };
  const { dubbing: _binding, ...unboundReview } = review;
  assert.throws(() => reviewLocalization(dir, unboundReview), /binding/);
  assert.throws(() => reviewLocalization(dir, { ...review, dubbing: { binding, language: "en" } }), /language/);
  const receipt = path.join(dir, "voiceover/hook.mp3.dubbing-source.json"),
    saved = readFileSync(receipt);
  writeFileSync(
    receipt,
    JSON.stringify({
      sourceSha256: "unrelated",
      sha256: hashFile(path.join(dir, "voiceover/hook.mp3")),
      language: "ru",
    }),
  );
  assert.throws(() => reviewLocalization(dir, review), /unrelated/);
  writeFileSync(receipt, saved);
  const wordsFile = path.join(dir, "voiceover/hook.words.json"),
    originalWords = readFileSync(wordsFile);
  writeFileSync(wordsFile, JSON.stringify({ ...JSON.parse(originalWords.toString()), sourceSha256: "wrong" }));
  assert.throws(() => reviewLocalization(dir, review), /source hash/);
  writeFileSync(wordsFile, originalWords);
  reviewLocalization(dir, review);
  assert.doesNotThrow(() => assertLocalizationReady(dir));
  const reviewFile = path.join(dir, "pipeline/localization.json"),
    pinned = readFileSync(reviewFile);
  const unbound = JSON.parse(pinned.toString());
  delete unbound.review.dubbing;
  writeFileSync(reviewFile, JSON.stringify(unbound));
  assert.throws(() => assertLocalizationReady(dir), /binding/);
  writeFileSync(reviewFile, pinned);
  state.targets.ru.status = "stale";
  writeFileSync(binding, JSON.stringify(state));
  assert.throws(() => assertLocalizationReady(dir), /stale/);
});
