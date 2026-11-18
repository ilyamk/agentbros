import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import vm from "node:vm";
import { DeliveryRequestSchema, DeliverySnapshotSchema, DeliveryManifestSchema } from "../src/types/delivery";
import { PlatformAudioPlacementSchema } from "../src/types/platform-audio";
import {
  planPlatformAudioEligibility,
  platformAudioHash,
  nativeSelectionHash,
  nativeMarksHash,
  platformAudioRequestHash,
  deliveryStateForPlatformAudio,
} from "../src/lib/delivery/platform-audio-plan";
import { platformFixture, zero, now } from "./platform-audio-fixtures";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "native-plan-pure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return platformFixture(root);
}
const inspect = (f: ReturnType<typeof fixture>) =>
  planPlatformAudioEligibility(f.request, f.plan, f.props, [f.identity], f.registry, f.use).result;
const repin = (f: ReturnType<typeof fixture>) => {
  f.entry.selectionReview.selectionHash = nativeSelectionHash(f.entry);
  f.entry.marksReview.selectionHash = f.entry.selectionReview.selectionHash;
  f.entry.marksReview.marksHash = nativeMarksHash(f.entry);
};
test("restricted prepared timeline yields prospective metadata only and preserves all protected props", (t) => {
  const f = fixture(t),
    before = JSON.stringify(f.props);
  const result = inspect(f);
  assert.deepEqual(result.findings, []);
  assert.equal(result.localStatus, "eligible-awaiting-movie");
  assert.equal(result.status, "pending-manual");
  assert.deepEqual(result.movieBindings, []);
  assert.equal(JSON.stringify(f.props), before);
  assert.ok(result.provenance.includes("declarations"));
});
test("exact TikTok and Meta routes are structural declarations; YouTube and mismatches remain blocked", (t) => {
  const f = fixture(t);
  for (const [platform, provider] of [
    ["instagram", "meta-sound-collection"],
    ["facebook", "meta-sound-collection"],
  ] as const) {
    f.entry.platform = platform;
    f.entry.resource.provider = provider;
    f.entry.target.placement = platform;
    f.request.placements = [platform];
    f.entry.resource.rights.allowedPlacements = [platform];
    repin(f);
    assert.equal(inspect(f).localStatus, "eligible-awaiting-movie");
  }
  f.entry.platform = "youtube";
  f.entry.resource.provider = "youtube-audio-library";
  f.entry.target.placement = "youtube";
  f.request.placements = ["youtube"];
  f.entry.resource.rights.allowedPlacements = ["youtube"];
  repin(f);
  assert.ok(inspect(f).findings.some((item) => item.code === "NATIVE_ROUTE_UNSUPPORTED"));
  f.entry.platform = "tiktok";
  repin(f);
  assert.equal(inspect(f).localStatus, "blocked");
});
test("unknown rights are not cleared by named pinned reviews", (t) => {
  const f = fixture(t);
  for (const change of [
    { licence: "unknown" },
    { verifiedAtSource: false },
    { commercialAllowed: "unknown" as const },
    { derivativesAllowed: "unknown" as const },
    { allowedPlacements: ["instagram"] },
    { allowedPlacements: [] },
  ]) {
    const original = f.entry.resource.rights;
    f.entry.resource.rights = { ...original, ...change };
    repin(f);
    assert.ok(inspect(f).findings.some((item) => item.code === "NATIVE_RIGHTS_UNCONFIRMED"));
    f.entry.resource.rights = original;
  }
});
test("native selection, territory, account and effective use are bound; old reviews never auto-update", (t) => {
  const f = fixture(t);
  for (const change of [
    () => {
      f.entry.territory = "CA";
    },
    () => {
      f.entry.account.identifier = "other";
    },
    () => {
      f.entry.resource.id = "other";
    },
    () => {
      f.use.contextSha256 = zero;
    },
  ]) {
    const entry = structuredClone(f.entry),
      use = structuredClone(f.use);
    change();
    assert.ok(inspect(f).findings.some((item) => item.code === "NATIVE_REVIEW_STALE"));
    Object.assign(f.entry, entry);
    Object.assign(f.use, use);
  }
});
test("rational interval/mark clocks reject out-of-range and mismatched native time, preserving explicit offsets", (t) => {
  const f = fixture(t);
  assert.equal(inspect(f).localStatus, "eligible-awaiting-movie");
  for (const change of [
    () => {
      f.entry.videoEnd = { num: 30001, den: 10000 };
    },
    () => {
      f.entry.sourceOffset = { num: 20, den: 1 };
    },
    () => {
      f.entry.videoStart = f.entry.videoEnd;
    },
    () => {
      f.entry.marks[0].trackTime = { num: 999, den: 1 };
    },
    () => {
      f.entry.marks.push({ ...f.entry.marks[0], id: "late" });
    },
  ]) {
    const entry = structuredClone(f.entry);
    change();
    repin(f);
    assert.equal(inspect(f).localStatus, "blocked");
    Object.assign(f.entry, entry);
  }
});
test("music ownership even zero gain, masters, embedded audio and unknown templates refuse", (t) => {
  const f = fixture(t);
  const original = structuredClone(f.props);
  for (const change of [
    () => {
      f.props.timeline!.tracks.push({
        id: "music",
        kind: "music",
        clips: [{ ...structuredClone(f.props.timeline!.tracks[1].clips[0]), payload: { volume: 0 } }],
      });
    },
    () => {
      f.request.audioMaster = "master.json";
    },
    () => {
      f.props.audioMaster = {
        source: "master.bin",
        sourceSha256: zero,
        durationSec: 3,
        integratedLufs: -16,
        truePeakDb: -2,
        targetLufs: -16,
        createdAt: now,
      };
    },
    () => {
      f.props.talkingHead = {
        enabled: true,
        presenterVideo: "fixture.bin",
        audioSource: "embedded",
      } as typeof f.props.talkingHead;
    },
    () => {
      f.props.timeline!.tracks[0].clips[0].payload!.scene = { visualType: "title", template: { id: "scene.hook" } };
    },
  ]) {
    change();
    assert.equal(inspect(f).localStatus, "blocked");
    Object.assign(f.props, structuredClone(original));
    delete f.request.audioMaster;
  }
});
test("exact immutable audible/span review is required and extra convenient reviews cannot certify", (t) => {
  const f = fixture(t);
  f.plan.sourceReviews[0].assetSha256 = zero;
  assert.ok(inspect(f).findings.some((item) => item.code === "NATIVE_CONTENT_REVIEW"));
  f.plan.sourceReviews[0].assetSha256 = f.registry.assets[0].hash;
  f.plan.sourceReviews.push({ ...f.plan.sourceReviews[0], clipId: "unrelated" });
  assert.ok(inspect(f).findings.some((item) => item.code === "NATIVE_CONTENT_REVIEW"));
});
test("strict schemas reject unsafe paths/IDs/territories/empty selections and ambiguous owners", (t) => {
  const f = fixture(t);
  for (const mutate of [
    () => {
      f.plan.entries = [];
    },
    () => {
      f.entry.territory = "unknown";
    },
    () => {
      f.entry.evidence.licence.file = "../licence";
    },
    () => {
      f.entry.sourceOffset = { num: -1, den: 1 };
    },
    () => {
      f.entry.account.identifier = "bad\u0000";
    },
    () => {
      f.plan.entries.push(structuredClone(f.entry));
    },
    () => {
      f.entry.marks.push(structuredClone(f.entry.marks[0]));
    },
  ]) {
    const original = structuredClone(f.plan);
    mutate();
    assert.equal(PlatformAudioPlacementSchema.safeParse(f.plan).success, false);
    Object.assign(f.plan, original);
    f.entry = f.plan.entries[0];
  }
});
test("post-render output reviews are excluded from prospective hash, while content reviews/selection mutate it", (t) => {
  const f = fixture(t),
    before = platformAudioRequestHash(f.request, f.plan);
  f.plan.outputReviews = [
    {
      ...f.review,
      musicContent: "declared-absent",
      entryId: f.entry.id,
      outputSha256: zero,
      sourceSnapshotHash: zero,
      propsHash: zero,
      selectionHash: f.entry.selectionReview.selectionHash,
    },
  ];
  assert.equal(platformAudioRequestHash(f.request, f.plan), before);
  f.plan.sourceReviews[0].note = "Changed source review";
  assert.notEqual(platformAudioRequestHash(f.request, f.plan), before);
});
test("native opt-in cannot reach production-ready; absent requests keep existing state semantics", () => {
  assert.equal(deliveryStateForPlatformAudio({ mode: "production" }, false), "production-ready");
  assert.equal(deliveryStateForPlatformAudio({ mode: "production" }, true), "blocked");
  assert.equal(deliveryStateForPlatformAudio({ mode: "draft" }, true), "draft-needs-review");
  for (const blocked of [false, true])
    assert.equal(
      deliveryStateForPlatformAudio({ mode: "production", platformAudioPlacement: {} }, blocked),
      "draft-needs-review",
    );
});
test("actual frozen pre-feature schemas preserve absent request/snapshot/manifest serialization and basis hashes", (t) => {
  const require = createRequire(import.meta.url),
    esbuild = createRequire(require.resolve("@remotion/bundler"))("esbuild"),
    source = fs.readFileSync(new URL("./fixtures/platform-audio-legacy-delivery.ts.txt", import.meta.url), "utf8");
  const module = { exports: {} as Record<string, { parse: (value: unknown) => unknown }> };
  vm.runInNewContext(
    esbuild.transformSync(source, { loader: "ts", format: "cjs" }).code,
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        assert.equal(name, "zod");
        return require("zod");
      },
    },
    { timeout: 500 },
  );
  const f = fixture(t),
    { platformAudioPlacement: _, ...request } = f.request;
  const snapshot = { version: 1, projectId: "demo", id: zero, createdAt: now, identities: [f.identity] };
  const manifest = {
    version: 1,
    projectId: "demo",
    snapshotId: zero,
    createdAt: now,
    state: "production-ready",
    request,
    sourceIdentities: [f.identity],
    findings: [],
    outputs: [],
    rights: [],
    costs: null,
    reviewEvidence: {},
    apiCalls: 0,
  };
  for (const [name, current, value] of [
    ["DeliveryRequestSchema", DeliveryRequestSchema, request],
    ["DeliverySnapshotSchema", DeliverySnapshotSchema, snapshot],
    ["DeliveryManifestSchema", DeliveryManifestSchema, manifest],
  ] as const) {
    const previous = module.exports[name].parse(value),
      actual = current.parse(value);
    assert.equal(JSON.stringify(actual), JSON.stringify(previous));
    assert.equal(platformAudioHash(actual), platformAudioHash(previous));
    assert.equal(Object.hasOwn(actual, "platformAudioPlacement"), false);
  }
});

test("role/note alone is not an explicit no-music source/output declaration; arbitrary output owners refuse", (t) => {
  const f = fixture(t);
  const source = structuredClone(f.plan.sourceReviews[0]) as Record<string, unknown>;
  delete source.musicContent;
  assert.equal(PlatformAudioPlacementSchema.safeParse({ ...f.plan, sourceReviews: [source] }).success, false);
  assert.equal(
    PlatformAudioPlacementSchema.safeParse({
      ...f.plan,
      outputReviews: [
        {
          ...f.review,
          musicContent: "declared-absent",
          entryId: "other",
          outputSha256: zero,
          sourceSnapshotHash: zero,
          propsHash: zero,
          selectionHash: zero,
        },
      ],
    }).success,
    false,
  );
});

import { aggregatePlatformAudioResults } from "../src/lib/delivery/platform-audio-plan";
test("all-output eligibility aggregation preserves any blocked status and deterministic explicit finding cap", (t) => {
  const f = fixture(t),
    clean = inspect(f);
  assert.equal(
    aggregatePlatformAudioResults([
      { format: "landscape", captions: "off", result: clean },
      { format: "vertical", captions: "off", result: { ...clean, localStatus: "blocked" } },
    ]).localStatus,
    "blocked",
  );
  const fallback = aggregatePlatformAudioResults([
    { format: "vertical", captions: "off", result: { ...clean, localStatus: "blocked" } },
  ]);
  assert.equal(fallback.findings[0].code, "NATIVE_OUTPUT_BLOCKED");
  const full = {
    ...clean,
    localStatus: "blocked" as const,
    findings: Array.from({ length: 128 }, (_, index) => ({ code: "NATIVE_TEST_FAIL", message: "Failure " + index })),
  };
  const outputs = [
    { format: "landscape" as const, captions: "off" as const, result: full },
    { format: "vertical" as const, captions: "off" as const, result: full },
  ];
  const aggregate = aggregatePlatformAudioResults(outputs);
  assert.equal(aggregate.localStatus, "blocked");
  assert.equal(aggregate.findings.length, 128);
  assert.equal(aggregate.findings[127].code, "NATIVE_FINDING_LIMIT");
  assert.ok(aggregate.findings[0].message.startsWith("landscape/off:"));
  assert.deepEqual(aggregate, aggregatePlatformAudioResults(outputs));
  assert.throws(() => aggregatePlatformAudioResults([]));
});
